"""Hunter.io contact provider for Agente 2 (Lead Researcher), RF15.

One Domain Search per lead: GET HUNTER_DOMAIN_SEARCH_URL with the company's
domain — or, when the lead has none, its name (`company=`), in which case
the domain Hunter picks must match the name (HUNTER_COMPANY_MATCH_MIN) or
its contacts are dropped. Only personal addresses of senior/executive
people in HUNTER_DEPARTMENTS are asked for, HUNTER_RESULTS_LIMIT at most:
one credit per search that finds something, none when it finds nothing.

search() returns a ProviderResult: the contacts plus the company data of
the response (CompanyInfo). A domain Hunter flags as disposable or webmail
is not a real company: its contacts are dropped.

Credits: the free /account endpoint is read once per provider instance
(one instance per run); the balance is then counted down locally — 1 per
search that found something (HUNTER_SEARCH_CREDIT_COST), 0.5 per email
verification (HUNTER_VERIFICATION_CREDIT_COST) — and a call is not made
once the balance is below its cost. If /account itself fails (other than
an invalid key) the call goes ahead: Hunter refuses it anyway when there
is nothing left.

verify_email() runs the Email Verifier on one address. It never raises:
no credits, a 202 ("still verifying") or any error returns None and the
contact keeps the status it had.

The API key lives only in memory (decrypted by from_pipeline_config) and
travels only in the X-API-KEY header — never in a URL, an exception, a
log line or repr(). Errors are raised as HunterError subclasses whose
class name is all EnrichmentService reports; Hunter's own error text goes
to the logs only, with the key masked. Contacts are personal data: logs
carry counts and status codes, never contact fields.

No fallback lives here: a search without results (including a domain with
only generic addresses, filtered out by type=personal) just returns [].
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from pydantic import BaseModel, ValidationError

from app.core import url_safety
from app.core.pipeline_constants import (
    HUNTER_ACCOUNT_TIMEOUT_SECONDS,
    HUNTER_ACCOUNT_URL,
    HUNTER_COMPANY_MATCH_MIN,
    HUNTER_DEPARTMENTS,
    HUNTER_DOMAIN_SEARCH_URL,
    HUNTER_EMAIL_TYPE,
    HUNTER_EMAIL_VERIFIER_URL,
    HUNTER_ERROR_DETAIL_MAX_CHARS,
    HUNTER_GENERIC_NAME_WORDS,
    HUNTER_MAX_RESPONSE_BYTES,
    HUNTER_MAX_SOURCE_URLS,
    HUNTER_RESULTS_LIMIT,
    HUNTER_SEARCH_CREDIT_COST,
    HUNTER_SEARCH_TIMEOUT_SECONDS,
    HUNTER_SENIORITY,
    HUNTER_VERIFICATION_CREDIT_COST,
    HUNTER_VERIFIER_TIMEOUT_SECONDS,
)
from app.schemas.contact import ContactRole, http_url_or_none
from app.services import company_domain_service, encryption_service
from app.services.company_domain_validation_service import domain_name_match
from app.services.enrichment_service import BaseProvider, CompanyInfo, ProviderResult, RawContact

logger = logging.getLogger(__name__)

SOURCE_NAME = "hunter"
VERIFICATION_SOURCE_DOMAIN_SEARCH = "hunter_domain_search"
VERIFICATION_SOURCE_EMAIL_VERIFIER = "hunter_email_verifier"
_EMAIL_TYPES = ("personal", "generic")


# ── Errors ────────────────────────────────────────────────────────────────────
class HunterError(Exception):
    """Base class. Never carries the key, the request or contact data."""


class HunterNotConfiguredError(HunterError):
    """No API key: no request is made."""


class HunterAuthError(HunterError):
    """HTTP 401: invalid API key."""


class HunterRateLimitError(HunterError):
    """HTTP 429: too many requests."""


class HunterNoCreditsError(HunterError):
    """The account has less than one credit left."""


class HunterHTTPError(HunterError):
    """Any other HTTP status >= 400, or a network error."""


class HunterResponseError(HunterError):
    """A body that is not the expected JSON (or was cut at the byte cap)."""


class HunterTimeoutError(HunterError, TimeoutError):
    """A TimeoutError, so EnrichmentService reports it as reason="timeout"."""


# ── Helpers ───────────────────────────────────────────────────────────────────
def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _confidence(value: Any) -> float:
    number = _number(value)
    if number is None:
        return 0.0
    return max(0.0, min(1.0, number / 100))


def _date(value: Any) -> Optional[datetime]:
    """Hunter dates ("2024-05-10") as UTC datetimes; None if unparseable."""
    text = _text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def error_detail(body: bytes, api_key: str) -> str:
    """Hunter's own reason for an error — the `details` of its `errors[]`,
    whitespace collapsed and cut to HUNTER_ERROR_DETAIL_MAX_CHARS — with the
    key masked in case it is echoed back. For the logs only."""
    try:
        payload = json.loads(body)
    except Exception:
        return ""
    errors = payload.get("errors") if isinstance(payload, dict) else None
    if not isinstance(errors, list):
        return ""
    details = [" ".join(e["details"].split()) for e in errors if isinstance(e, dict) and isinstance(e.get("details"), str)]
    detail = "; ".join(d for d in details if d)
    if api_key:
        detail = detail.replace(api_key, "***")
    return detail[:HUNTER_ERROR_DETAIL_MAX_CHARS]


def remaining_credits(payload: Any) -> Optional[float]:
    """data.requests.credits.remaining, else data.requests.searches.remaining;
    None when neither is a number."""
    data = payload.get("data") if isinstance(payload, dict) else None
    requests = data.get("requests") if isinstance(data, dict) else None
    if not isinstance(requests, dict):
        return None
    for bucket in ("credits", "searches"):
        counts = requests.get(bucket)
        if isinstance(counts, dict):
            remaining = _number(counts.get("remaining"))
            if remaining is not None:
                return remaining
    return None


def _flag(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def company_info(data: Dict[str, Any]) -> CompanyInfo:
    """The company fields of a Domain Search `data`. headcount is not one
    of them today; it is read only in case Hunter starts sending it."""
    return CompanyInfo(
        domain=_text(data.get("domain")) or None,
        organization=_text(data.get("organization")) or None,
        pattern=_text(data.get("pattern")) or None,
        accept_all=_flag(data.get("accept_all")),
        disposable=_flag(data.get("disposable")),
        webmail=_flag(data.get("webmail")),
        headcount=_text(data.get("headcount")) or None,
    )


def _distinctive_words(company_name: str) -> List[str]:
    decomposed = unicodedata.normalize("NFKD", company_name)
    folded = "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower().replace(".", "")
    return [word for word in re.split(r"[^a-z0-9]+", folded) if word and word not in HUNTER_GENERIC_NAME_WORDS]


def company_name_match(domain: Any, company_name: Any) -> float:
    """How well `domain` matches `company_name`, ignoring generic words
    (HUNTER_GENERIC_NAME_WORDS). Only two candidates are compared with the
    domain: the distinctive words joined ("British Airways" →
    "britishairways") and the first distinctive word ("british") — never
    any other single word, so "HSBC Global Services" does not match
    services.com nor "British Airways" airways.com. A name with no
    distinctive word scores 0. Known limit: the first word alone still
    matches (british.com ~ "British Airways"). Never raises."""
    try:
        if not isinstance(company_name, str):
            return 0.0
        words = _distinctive_words(company_name)
        if not words:
            return 0.0
        return max(domain_name_match(domain, "".join(words)), domain_name_match(domain, words[0]))
    except Exception:
        return 0.0


def to_raw_contact(item: Any, company: str) -> Optional[RawContact]:
    """One entry of data.emails[] as a RawContact; None when it has no name
    or does not validate. role stays unknown (role mapping is a later phase)."""
    if not isinstance(item, dict):
        return None
    full_name = " ".join(part for part in (_text(item.get("first_name")), _text(item.get("last_name"))) if part)
    if not full_name:
        return None

    verification = item.get("verification") if isinstance(item.get("verification"), dict) else {}
    sources = item.get("sources") if isinstance(item.get("sources"), list) else []
    source_urls = [
        url for url in (http_url_or_none(s.get("uri")) for s in sources if isinstance(s, dict)) if url
    ][:HUNTER_MAX_SOURCE_URLS]
    last_seen = [d for d in (_date(s.get("last_seen_on")) for s in sources if isinstance(s, dict)) if d]
    email_type = _text(item.get("type"))
    verification_status = _text(verification.get("status")) or None
    confidence = _confidence(item.get("confidence"))

    try:
        return RawContact(
            full_name=full_name,
            job_title=_text(item.get("position")),
            company=company,
            email=_text(item.get("value")) or None,
            linkedin_url=item.get("linkedin") if isinstance(item.get("linkedin"), str) else None,
            role=ContactRole.UNKNOWN,
            # contact_ranking_service turns confidence_score into the adjusted
            # confidence; provider_confidence_score keeps Hunter's own.
            confidence_score=confidence,
            provider_confidence_score=confidence,
            source=SOURCE_NAME,
            email_type=email_type if email_type in _EMAIL_TYPES else None,
            email_verification_status=verification_status,
            email_verified_at=_date(verification.get("date")),
            email_verification_source=VERIFICATION_SOURCE_DOMAIN_SEARCH if verification_status else None,
            seniority=_text(item.get("seniority")) or None,
            department=_text(item.get("department")) or None,
            source_urls=source_urls,
            source_last_seen_at=max(last_seen) if last_seen else None,
        )
    except ValidationError:
        return None


class EmailVerification(BaseModel):
    """An Email Verifier answer: Hunter's data.status as sent (valid,
    invalid, accept_all, webmail, disposable, unknown — data.result is
    obsolete and ignored) and its date, today (UTC) when it has none."""

    status: str
    verified_at: datetime
    source: str = VERIFICATION_SOURCE_EMAIL_VERIFIER


# ── Provider ──────────────────────────────────────────────────────────────────
class HunterProvider(BaseProvider):
    name = SOURCE_NAME

    def __init__(self, api_key: str):
        self._api_key = (api_key or "").strip()
        self._credits: Optional[float] = None
        self._credits_checked = False
        self._auth_failed = False
        self._credits_lock = asyncio.Lock()

    def __repr__(self) -> str:
        return "HunterProvider()"

    async def search(self, company: str, job_context: str, *, domain: Optional[str] = None) -> ProviderResult:
        if not self._api_key:
            raise HunterNotConfiguredError()
        company_name = _text(company)
        searched_domain = company_domain_service.normalize_domain(domain) if domain else None
        if not searched_domain and not company_name:
            return ProviderResult()

        await self._ensure_credits(HUNTER_SEARCH_CREDIT_COST)

        params: Dict[str, Any] = {
            "type": HUNTER_EMAIL_TYPE,
            "seniority": ",".join(HUNTER_SENIORITY),
            "limit": HUNTER_RESULTS_LIMIT,
            "offset": 0,
        }
        if HUNTER_DEPARTMENTS:
            params["department"] = ",".join(HUNTER_DEPARTMENTS)
        if searched_domain:
            params["domain"] = searched_domain
        else:
            params["company"] = company_name

        payload = await self._get_json("domain-search", HUNTER_DOMAIN_SEARCH_URL, params, HUNTER_SEARCH_TIMEOUT_SECONDS)
        data = payload.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("emails"), list):
            logger.warning("hunter: domain-search response without data.emails")
            raise HunterResponseError()
        emails = data["emails"]
        if emails:
            self._spend(HUNTER_SEARCH_CREDIT_COST)  # a search that finds something costs one credit
        company = company_info(data)

        if company.disposable or company.webmail:
            logger.info("hunter: domain is disposable or webmail, not a company; %d email(s) dropped", len(emails))
            return ProviderResult(company=company)

        if not searched_domain:
            resolved = company_domain_service.normalize_domain(data.get("domain"))
            if company_name_match(resolved, company_name) < HUNTER_COMPANY_MATCH_MIN:
                logger.info(
                    "hunter: company search resolved to a domain that does not match the name; %d email(s) dropped",
                    len(emails),
                )
                return ProviderResult(company=company)

        organization = _text(data.get("organization")) or company_name or searched_domain or ""
        contacts = [c for c in (to_raw_contact(item, organization) for item in emails) if c is not None]
        dropped = len(emails) - len(contacts)
        if dropped:
            logger.warning("hunter: %d email(s) without a name or invalid; dropped", dropped)
        return ProviderResult(contacts=contacts, company=company)

    async def verify_email(self, email: str) -> Optional[EmailVerification]:
        """Email Verifier for one address (0.5 credit). None — never an
        exception — when there is no key or credit, Hunter is still
        verifying (HTTP 202), or anything fails."""
        address = _text(email)
        if not self._api_key or not address:
            return None
        try:
            await self._ensure_credits(HUNTER_VERIFICATION_CREDIT_COST)
            status_code, payload = await self._get_json(
                "email-verifier", HUNTER_EMAIL_VERIFIER_URL, {"email": address}, HUNTER_VERIFIER_TIMEOUT_SECONDS,
                with_status=True,
            )
        except HunterError as exc:
            logger.warning("hunter: email verification skipped (%s)", type(exc).__name__)
            return None
        # Counted on a 202 too, to stay on the safe side of the balance.
        self._spend(HUNTER_VERIFICATION_CREDIT_COST)
        if status_code == 202:
            logger.info("hunter: email verification still in progress (HTTP 202); status kept")
            return None
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        status = _text(data.get("status"))
        if not status:
            logger.warning("hunter: email-verifier response without data.status")
            return None
        verification = data.get("verification") if isinstance(data.get("verification"), dict) else {}
        verified_at = _date(verification.get("date")) or datetime.now(timezone.utc)
        return EmailVerification(status=status, verified_at=verified_at)

    def _spend(self, cost: float) -> None:
        if self._credits is not None:
            self._credits -= cost

    async def _ensure_credits(self, cost: float) -> None:
        async with self._credits_lock:
            if self._auth_failed:
                raise HunterAuthError()
            if not self._credits_checked:
                self._credits_checked = True
                try:
                    payload = await self._get_json("account", HUNTER_ACCOUNT_URL, None, HUNTER_ACCOUNT_TIMEOUT_SECONDS)
                    self._credits = remaining_credits(payload)
                except HunterAuthError:
                    self._auth_failed = True
                    raise
                except HunterError as exc:
                    logger.warning("hunter: could not read account credits (%s); searching anyway", type(exc).__name__)
        if self._credits is not None and self._credits < cost:
            raise HunterNoCreditsError()

    async def _get_json(
        self, endpoint: str, url: str, params: Optional[Dict[str, Any]], timeout: float, *, with_status: bool = False,
    ) -> Any:
        """GET a fixed Hunter URL; the parsed JSON object (preceded by the
        status code when `with_status`), or a HunterError. `from None`: an
        httpx error's context holds the request, whose headers carry the key."""
        headers = {"X-API-KEY": self._api_key, "Accept": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                status_code, body = await url_safety.safe_get_bytes(
                    client, url, headers=headers, params=params, max_bytes=HUNTER_MAX_RESPONSE_BYTES,
                )
        except httpx.TimeoutException:
            logger.warning("hunter: %s timed out after %ss", endpoint, timeout)
            raise HunterTimeoutError() from None
        except (httpx.HTTPError, url_safety.UnsafeUrlError) as exc:
            logger.warning("hunter: %s failed with %s", endpoint, type(exc).__name__)
            raise HunterHTTPError() from None

        if status_code >= 400:
            logger.warning(
                "hunter: %s returned HTTP %d: %s", endpoint, status_code, error_detail(body, self._api_key),
            )
            if status_code == 401:
                raise HunterAuthError()
            if status_code == 429:
                raise HunterRateLimitError()
            raise HunterHTTPError()
        if with_status and status_code == 202:
            return status_code, {}  # still in progress: its body, if any, has no result
        if len(body) >= HUNTER_MAX_RESPONSE_BYTES:
            logger.warning("hunter: %s response cut at %d bytes", endpoint, HUNTER_MAX_RESPONSE_BYTES)
            raise HunterResponseError()
        try:
            payload = json.loads(body)
        except ValueError:
            logger.warning("hunter: %s response is not valid JSON", endpoint)
            raise HunterResponseError() from None
        if not isinstance(payload, dict):
            logger.warning("hunter: %s response is not a JSON object", endpoint)
            raise HunterResponseError()
        return (status_code, payload) if with_status else payload


def from_pipeline_config(config: Dict[str, Any]) -> Optional[HunterProvider]:
    """A HunterProvider with the key of a pipeline_configs document,
    decrypted in memory only; None when no key is stored or it cannot be
    decrypted (missing PIPELINE_ENCRYPTION_KEY, or a different one)."""
    token = (config or {}).get("hunter_api_key_encrypted")
    if not token:
        return None
    try:
        api_key = encryption_service.decrypt(token)
    except Exception as exc:
        logger.warning("hunter: stored API key cannot be decrypted (%s)", type(exc).__name__)
        return None
    return HunterProvider(api_key) if api_key.strip() else None
