"""Email verification for Agente 2 contacts: address format + a domain that
receives mail.

What "valid" means — and what it does not:
    VALID means the address is well-formed AND its domain accepts mail: it has
    an MX record, or (with no MX at all) an A/AAAA record, which RFC 5321 §5.1
    treats as an implicit MX. It does NOT confirm that the mailbox exists —
    that would take an SMTP probe, which this service never does.

The three outcomes:
    VALID    — format ok and the domain receives mail.
    INVALID  — malformed address, or DNS answered definitively that the domain
               does not receive mail (NXDOMAIN, null MX, no MX/A/AAAA).
    UNKNOWN  — DNS could not answer: timeout, SERVFAIL / no nameservers, a
               network error. A transient failure is never reported as INVALID.

verify_email never raises: odd input (None, non-text, blank, too long,
control characters) is INVALID / invalid_format without any DNS query, and
any unexpected error while checking the domain is UNKNOWN / dns_error.

Logs carry the domain and the outcome only, never the address itself
(personal data).
"""
from __future__ import annotations

import asyncio
import logging
import time
import unicodedata
from enum import Enum
from typing import Any, List, Optional, Tuple

import dns.asyncresolver
import dns.exception
import dns.name
import dns.resolver
from email_validator import EmailNotValidError, validate_email
from pydantic import BaseModel

from app.core.pipeline_constants import EMAIL_MX_TIMEOUT_SECONDS

logger = logging.getLogger(__name__)

# RFC 5321 §4.5.3.1.3: a forward-path is at most 256 octets including the
# angle brackets, i.e. 254 for the address itself.
EMAIL_MAX_LENGTH = 254

REASON_OK = "ok"
REASON_INVALID_FORMAT = "invalid_format"
REASON_DOMAIN_NOT_FOUND = "domain_not_found"
REASON_NULL_MX = "null_mx"
REASON_IMPLICIT_MX = "implicit_mx_a_record"
REASON_NO_MAIL_HOST = "no_mail_host"
REASON_DNS_TIMEOUT = "dns_timeout"
REASON_DNS_ERROR = "dns_error"


class EmailStatus(str, Enum):
    VALID = "valid"
    INVALID = "invalid"
    UNKNOWN = "unknown"


class EmailVerification(BaseModel):
    email: str               # normalized by email-validator, or the input as given if malformed ("" for non-text)
    format_valid: bool
    has_mx: Optional[bool]   # True: MX found; False: no usable MX; None: could not tell
    status: EmailStatus
    reason: str


# ── Format ────────────────────────────────────────────────────────────────────
def _has_control_chars(value: str) -> bool:
    # Cc covers \n, \r, \t, \x00, DEL...; Zl/Zp are U+2028/U+2029.
    return any(unicodedata.category(ch) in ("Cc", "Zl", "Zp") for ch in value)


def check_format(email: Any) -> Tuple[bool, Optional[str], Optional[str]]:
    """(format ok, normalized address, ASCII domain). No network access.

    Control characters are rejected anywhere in the input, before trimming:
    a trailing newline is a sign of injected or corrupted data, not padding."""
    if not isinstance(email, str) or _has_control_chars(email):
        return False, None, None
    candidate = email.strip()
    if not candidate or len(candidate) > EMAIL_MAX_LENGTH:
        return False, None, None
    try:
        result = validate_email(candidate, check_deliverability=False)
    except EmailNotValidError:
        return False, None, None
    return True, result.normalized, result.ascii_domain


# ── DNS ───────────────────────────────────────────────────────────────────────
_resolver: Optional[dns.asyncresolver.Resolver] = None


def _get_resolver() -> dns.asyncresolver.Resolver:
    # Built on first use, not at import: creating a Resolver reads the system's
    # DNS configuration, and importing this module must not depend on it.
    global _resolver
    if _resolver is None:
        _resolver = dns.asyncresolver.Resolver()
    return _resolver


async def _resolve(domain: str, rdtype: str, lifetime: float) -> Any:
    """The only place that touches the network. Tests replace it."""
    return await _get_resolver().resolve(domain, rdtype, lifetime=lifetime, search=False)


async def _query(domain: str, rdtype: str, deadline: float) -> Any:
    """One query within the shared deadline. `lifetime` asks dnspython to
    stop in time; wait_for enforces it regardless."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError
    return await asyncio.wait_for(_resolve(domain, rdtype, remaining), timeout=remaining)


def _is_timeout(exc: BaseException) -> bool:
    # asyncio.TimeoutError is its own type before Python 3.11 (an alias of
    # TimeoutError from 3.11 on), so both are listed.
    return isinstance(exc, (dns.exception.Timeout, TimeoutError, asyncio.TimeoutError))


def _transient(exc: BaseException) -> Tuple[EmailStatus, Optional[bool], str]:
    return EmailStatus.UNKNOWN, None, REASON_DNS_TIMEOUT if _is_timeout(exc) else REASON_DNS_ERROR


def _real_mail_hosts(answer: Any) -> Tuple[List[Any], bool]:
    """(MX records pointing at a real host, whether any record was a null MX).
    A null MX (RFC 7505: preference 0, exchange ".") says the domain accepts
    no mail; an exchange of "." is never a deliverable host."""
    real, saw_null = [], False
    for record in answer:
        if getattr(record, "exchange", None) == dns.name.root:
            saw_null = True
        else:
            real.append(record)
    return real, saw_null


async def _check_address_records(domain: str, deadline: float) -> Tuple[EmailStatus, Optional[bool], str]:
    """No MX: RFC 5321 §5.1 falls back to the domain's A/AAAA (implicit MX)."""
    results = await asyncio.gather(
        _query(domain, "A", deadline),
        _query(domain, "AAAA", deadline),
        return_exceptions=True,
    )
    for result in results:
        if isinstance(result, BaseException) and not isinstance(result, Exception):
            raise result  # cancellation and the like: not ours to swallow
    if any(not isinstance(result, BaseException) and len(result) > 0 for result in results):
        return EmailStatus.VALID, False, REASON_IMPLICIT_MX

    failures = [r for r in results if isinstance(r, Exception)]
    definitive = (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN)
    if all(isinstance(f, definitive) for f in failures):
        return EmailStatus.INVALID, False, REASON_NO_MAIL_HOST
    transient = [f for f in failures if not isinstance(f, definitive)]
    if any(_is_timeout(f) for f in transient):
        return EmailStatus.UNKNOWN, None, REASON_DNS_TIMEOUT
    return EmailStatus.UNKNOWN, None, REASON_DNS_ERROR


async def check_domain(ascii_domain: str, timeout: float = EMAIL_MX_TIMEOUT_SECONDS) -> Tuple[EmailStatus, Optional[bool], str]:
    """(status, has_mx, reason) for `ascii_domain` (already IDNA-encoded).
    `timeout` is the budget for every query this check makes, together."""
    deadline = time.monotonic() + timeout
    try:
        answer = await _query(ascii_domain, "MX", deadline)
    except dns.resolver.NXDOMAIN:
        return EmailStatus.INVALID, False, REASON_DOMAIN_NOT_FOUND
    except dns.resolver.NoAnswer:
        answer = []
    except Exception as exc:  # timeout, SERVFAIL / NoNameservers, network error...
        return _transient(exc)

    real, saw_null = _real_mail_hosts(answer)
    if real:
        return EmailStatus.VALID, True, REASON_OK
    if saw_null:
        return EmailStatus.INVALID, False, REASON_NULL_MX
    try:
        return await _check_address_records(ascii_domain, deadline)
    except Exception as exc:
        return _transient(exc)


# ── Public entry point ────────────────────────────────────────────────────────
def _budget(timeout: Any) -> float:
    try:
        return float(timeout)
    except (TypeError, ValueError):
        return 0.0  # no usable budget: the DNS check reports dns_timeout


async def verify_email(email: Any, timeout: float = EMAIL_MX_TIMEOUT_SECONDS) -> EmailVerification:
    """Verify an address's format and that its domain receives mail.

    VALID = well-formed + the domain receives mail. It does NOT confirm the
    mailbox exists. Never raises (see module docstring)."""
    try:
        format_ok, normalized, ascii_domain = check_format(email)
    except Exception:  # defensive: check_format is not expected to raise
        format_ok, normalized, ascii_domain = False, None, None

    if not format_ok:
        logger.info("email_verification: invalid format, DNS not queried")
        return EmailVerification(
            email=email if isinstance(email, str) else "",
            format_valid=False,
            has_mx=None,
            status=EmailStatus.INVALID,
            reason=REASON_INVALID_FORMAT,
        )

    try:
        status, has_mx, reason = await check_domain(ascii_domain, _budget(timeout))
    except Exception as exc:  # defensive: check_domain already maps its errors
        logger.warning("email_verification: %s unexpected %s", ascii_domain, type(exc).__name__)
        status, has_mx, reason = EmailStatus.UNKNOWN, None, REASON_DNS_ERROR

    logger.info("email_verification: %s -> %s (%s)", ascii_domain, status.value, reason)
    return EmailVerification(
        email=normalized,
        format_valid=True,
        has_mx=has_mx,
        status=status,
        reason=reason,
    )
