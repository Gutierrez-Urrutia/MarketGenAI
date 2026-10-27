"""Validation of a company's domain (T9b): does it exist in DNS, and how
well does it match the company's name.

What the result means:
    status — reuses email_verification_service.check_domain, so it is the
    same DNS verdict as for an email address's domain:
      VALID    — the domain exists and receives mail: it has an MX record
                 (has_mx True), or no MX but an A/AAAA record (has_mx False,
                 reason "implicit_mx_a_record"). Callers that need a mail
                 domain should prefer has_mx True.
      INVALID  — DNS answered definitively: NXDOMAIN, a null MX (RFC 7505:
                 the domain says it accepts no mail), or no MX and no
                 A/AAAA. Also any input that is not already a normalized
                 company domain (reason "invalid_domain", no DNS query).
      UNKNOWN  — DNS could not answer (timeout, SERVFAIL, network error).
                 A transient failure is never reported as INVALID.

    name_match — 0.0 to 1.0, how close the domain's name is to the company
    name. Informative only: it NEVER changes status. A company's website
    domain can legitimately differ from its name (a brand, a parent group)
    and from the domain its staff's email addresses use.

validate_company_domain never raises. Logs carry the domain and the reason
only — never the company name.
"""
from __future__ import annotations

import difflib
import logging
import re
import unicodedata
from typing import Any, List, Optional

import idna
from pydantic import BaseModel, Field

from app.core.pipeline_constants import EMAIL_MX_TIMEOUT_SECONDS
from app.services import company_domain_service, email_verification_service
from app.services.email_verification_service import EmailStatus

logger = logging.getLogger(__name__)

REASON_INVALID_DOMAIN = "invalid_domain"

# Legal-form words dropped from a company name before comparing it with a
# domain ("Brisa Labs Inc" → "brisa labs"). Dots are removed first, so
# "S.A." and "S.p.A." arrive here as "sa" and "spa".
LEGAL_SUFFIXES = frozenset({"inc", "llc", "ltd", "ab", "sa", "spa", "corp", "gmbh", "co"})


class DomainValidation(BaseModel):
    domain: str
    status: EmailStatus
    has_mx: Optional[bool]   # as check_domain reports it; None when unknown or not queried
    reason: str
    name_match: float = Field(0.0, ge=0.0, le=1.0)  # informative only, never affects status


# ── Name match ────────────────────────────────────────────────────────────────
def _fold(text: str) -> str:
    """Lowercase, accents removed ("Ñandú" → "nandu")."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower()


def _name_tokens(company_name: str) -> List[str]:
    words = re.split(r"[^a-z0-9]+", _fold(company_name).replace(".", ""))
    return [word for word in words if word and word not in LEGAL_SUFFIXES]


def _domain_label(domain: str) -> str:
    """The part of a registrable domain before its public suffix
    ("brisacode.co.uk" → "brisacode"), decoded from punycode
    ("xn--bcherwald-q9a.de" → "bücherwald")."""
    suffix = company_domain_service._psl_full().publicsuffix(domain) or ""
    label = domain[: -(len(suffix) + 1)] if suffix and domain.endswith("." + suffix) else domain.split(".")[0]
    label = label.rsplit(".", 1)[-1]
    try:
        return idna.decode(label)
    except Exception:
        return label


def _similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


def domain_name_match(domain: Any, company_name: Any) -> float:
    """0.0–1.0: closeness between a domain and a company name. Compares the
    domain's label (whole, and split on hyphens) with the name's words, both
    one by one and joined ("Track it Forward" ~ "trackitforward"), after
    folding accents and case and dropping legal suffixes. Never raises."""
    try:
        if not isinstance(domain, str) or not isinstance(company_name, str):
            return 0.0
        tokens = _name_tokens(company_name)
        label = _fold(_domain_label(domain.strip().lower()))
        if not tokens or not label:
            return 0.0
        name_candidates = {"".join(tokens), *tokens}
        label_candidates = {label.replace("-", ""), *(part for part in label.split("-") if part)}
        score = max(_similarity(n, d) for n in name_candidates for d in label_candidates)
        return round(score, 3)
    except Exception:
        return 0.0


# ── Validation ────────────────────────────────────────────────────────────────
async def _validate(domain: Any, company_name: Any, timeout: Any) -> DomainValidation:
    if not isinstance(domain, str) or company_domain_service.normalize_domain(domain) != domain:
        logger.info("company_domain_validation: input is not a normalized company domain, DNS not queried")
        return DomainValidation(
            domain=domain if isinstance(domain, str) else "",
            status=EmailStatus.INVALID,
            has_mx=None,
            reason=REASON_INVALID_DOMAIN,
            name_match=domain_name_match(domain, company_name),
        )

    try:
        status, has_mx, reason = await email_verification_service.check_domain(
            domain, email_verification_service._budget(timeout),
        )
    except Exception as exc:  # defensive: check_domain already maps its errors
        logger.warning("company_domain_validation: %s unexpected %s", domain, type(exc).__name__)
        status, has_mx, reason = EmailStatus.UNKNOWN, None, email_verification_service.REASON_DNS_ERROR

    logger.info("company_domain_validation: %s -> %s (%s)", domain, status.value, reason)
    return DomainValidation(
        domain=domain,
        status=status,
        has_mx=has_mx,
        reason=reason,
        name_match=domain_name_match(domain, company_name),
    )


async def validate_company_domain(
    domain: Any, company_name: Any, timeout: float = EMAIL_MX_TIMEOUT_SECONDS,
) -> DomainValidation:
    """DNS verdict for `domain` plus an informative name_match against
    `company_name`. `domain` must already be normalized (as
    company_domain_service.normalize_domain returns it); anything else is
    INVALID / invalid_domain without a DNS query. Never raises."""
    try:
        return await _validate(domain, company_name, timeout)
    except Exception as exc:  # defensive: nothing above is expected to raise
        logger.warning("company_domain_validation: unexpected %s", type(exc).__name__)
        return DomainValidation(
            domain=domain if isinstance(domain, str) else "",
            status=EmailStatus.UNKNOWN,
            has_mx=None,
            reason=email_verification_service.REASON_DNS_ERROR,
        )
