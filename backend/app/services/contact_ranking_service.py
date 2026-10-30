"""Role, ranking, confidence and email verification of a lead's contacts
(Agente 2, RF15). Runs after EnrichmentService.find_contacts, the same way
for every provider: providers only report contacts (role "unknown").

NoonDalton sells BPO services to the company; the vacancy is only the
signal. Who to contact, best first (tiers in pipeline_constants):
  0. executive / owner — only in a small company;
  1. the head of the vacancy's area (VP, director, head of...);
  2. procurement / supplier management; a finance head when the service is
     back office / underwriting / insurance; a manager of the vacancy's area;
  3. executive of a medium company;   4. head of another area;
  5. executive of a large company;
  6. last resort: other hiring managers, HR, merchandise buyers;
  7. unknown title with senior/executive seniority.
Operational staff (drivers, couriers, coordinators, non-chief officers...)
and unknown titles without senior seniority are never delivered. Within a
tier: seniority, then adjusted confidence, then verification status, then
the original order — so the result is deterministic.

Confidence: the provider's confidence x the factor of the email's
verification status (invalid / disposable addresses are dropped), capped
for generic addresses. confidence_score holds the adjusted value;
provider_confidence_score keeps the provider's.

Company size comes from CompanyInfo.headcount, which Hunter's Domain Search
does not return: in practice every company is COMPANY_SIZE_DEFAULT
("medium") until another source sets a headcount.

Pure except select_contacts, which awaits the verifier it is given. Logs
carry counts only, never contact data.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any, FrozenSet, Iterable, List, Optional, Sequence, Tuple

from pydantic import BaseModel

from app.core.pipeline_constants import (
    BUYER_TITLE_WORDS,
    CHIEF_FUNCTION_WORDS,
    COMPANY_SIZE_DEFAULT,
    COMPANY_SIZE_MEDIUM_MAX,
    COMPANY_SIZE_SMALL_MAX,
    CONFIDENCE_FACTOR_BY_VERIFICATION,
    CONTACT_TITLE_AREAS,
    DEPARTMENT_HEAD_TITLE_PHRASES,
    DROPPED_VERIFICATION_STATUSES,
    EXECUTIVE_EXCLUDED_PHRASES,
    EXECUTIVE_TITLE_PHRASES,
    FINANCE_VACANCY_AREAS,
    FUNCTION_CHIEF_ACRONYMS,
    GENERIC_EMAIL_CONFIDENCE_CAP,
    HIRING_MANAGER_TITLE_PHRASES,
    HR_TITLE_PHRASES,
    HUNTER_MAX_VERIFICATIONS_PER_LEAD,
    OPERATIONAL_TITLE_WORDS,
    PROCUREMENT_TITLE_PHRASES,
    RANK_TIER_AREA_HEAD,
    RANK_TIER_AREA_MANAGER,
    RANK_TIER_EXECUTIVE_LARGE,
    RANK_TIER_EXECUTIVE_MEDIUM,
    RANK_TIER_EXECUTIVE_SMALL,
    RANK_TIER_FINANCE,
    RANK_TIER_LAST_RESORT,
    RANK_TIER_OTHER_HEAD,
    RANK_TIER_PROCUREMENT,
    RANK_TIER_UNKNOWN_SENIOR,
    RANK_TOP_N,
    SENIOR_SENIORITIES,
    SENIORITY_RANK,
    SENIORITY_RANK_DEFAULT,
    TITLE_LEADERSHIP_WORDS,
    VACANCY_AREA_CONTACT_AREAS,
    VACANCY_AREA_KEYWORDS,
    VERIFICATION_RANK,
)
from app.schemas.contact import ContactRole
from app.services.enrichment_service import CompanyInfo, RawContact

logger = logging.getLogger(__name__)

SIZE_SMALL = "small"
SIZE_MEDIUM = "medium"
SIZE_LARGE = "large"


class LeadContext(BaseModel):
    """What the ranking needs from a lead — plain values, built by the
    caller; the ranking never sees the lead document."""

    job_title: str = ""  # the vacancy's title (job_context)
    company_name: str = ""
    company_domain: Optional[str] = None


class TitleClassification(BaseModel):
    role: ContactRole
    excluded: bool = False          # operational staff / unknown junior: never delivered
    merchandise_buyer: bool = False  # a "Buyer" of a product company: last resort
    areas: FrozenSet[str] = frozenset()


# ── Text ──────────────────────────────────────────────────────────────────────
def _words(text: Any) -> List[str]:
    """Lowercase, accent-free words ("Co-Founder & CEO" → co, founder, ceo)."""
    if not isinstance(text, str):
        return []
    decomposed = unicodedata.normalize("NFKD", text)
    folded = "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower()
    return [word for word in re.split(r"[^a-z0-9]+", folded) if word]


def _has_phrase(words: Sequence[str], phrase: str) -> bool:
    target = phrase.split()
    size = len(target)
    return any(list(words[i:i + size]) == target for i in range(len(words) - size + 1))


def _has_any(words: Sequence[str], phrases: Iterable[str]) -> bool:
    return any(_has_phrase(words, phrase) for phrase in phrases)


def _without_phrases(words: Sequence[str], phrases: Iterable[str]) -> List[str]:
    """`words` with every occurrence of `phrases` removed."""
    result = list(words)
    for phrase in phrases:
        target = phrase.split()
        size = len(target)
        i = 0
        while i <= len(result) - size:
            if result[i:i + size] == target:
                del result[i:i + size]
            else:
                i += 1
    return result


# ── Areas ─────────────────────────────────────────────────────────────────────
def vacancy_area(job_title: Any) -> Optional[str]:
    """Area of the vacancy ("Customer Support Agent" → "customer_service"),
    or None. First area of VACANCY_AREA_KEYWORDS with a match."""
    words = _words(job_title)
    for area, phrases in VACANCY_AREA_KEYWORDS.items():
        if _has_any(words, phrases):
            return area
    return None


def title_areas(title: Any) -> FrozenSet[str]:
    """Areas a contact's title names ("Customer Operations Manager" →
    {"customer", "operations"})."""
    words = _words(title)
    return frozenset(area for area, phrases in CONTACT_TITLE_AREAS.items() if _has_any(words, phrases))


# ── Role ──────────────────────────────────────────────────────────────────────
def _chief_officer_kind(words: Sequence[str]) -> Optional[str]:
    """"function" for a chief officer of a function (COO, Chief Financial
    Officer...), "other" for any other "chief ... officer" (Chief Growth
    Officer), None if the title has none."""
    if set(words) & FUNCTION_CHIEF_ACRONYMS:
        return "function"
    if "chief" not in words or "officer" not in words:
        return None
    start = words.index("chief")
    end = len(words) - 1 - list(reversed(words)).index("officer")
    if end <= start:
        return None
    return "function" if set(words[start + 1:end]) & CHIEF_FUNCTION_WORDS else "other"


def classify_title(title: Any, seniority: Any = None) -> TitleClassification:
    """Role of a contact from its title; the first rule that matches wins:
    operational staff (excluded) → executive → procurement → department
    head → HR → hiring manager → unknown (excluded unless senior)."""
    words = _words(title)
    areas = title_areas(title)
    word_set = set(words)

    if word_set & OPERATIONAL_TITLE_WORDS and not word_set & TITLE_LEADERSHIP_WORDS:
        return TitleClassification(role=ContactRole.UNKNOWN, excluded=True, areas=areas)

    chief = _chief_officer_kind(words)
    if chief == "other" or _has_any(_without_phrases(words, EXECUTIVE_EXCLUDED_PHRASES), EXECUTIVE_TITLE_PHRASES):
        return TitleClassification(role=ContactRole.EXECUTIVE, areas=areas)

    if _has_any(words, PROCUREMENT_TITLE_PHRASES):
        return TitleClassification(role=ContactRole.PROCUREMENT, areas=areas)
    if _has_any(words, BUYER_TITLE_WORDS):
        return TitleClassification(role=ContactRole.PROCUREMENT, merchandise_buyer=True, areas=areas)

    if chief == "function" or _has_any(words, DEPARTMENT_HEAD_TITLE_PHRASES):
        return TitleClassification(role=ContactRole.DEPARTMENT_HEAD, areas=areas)
    if _has_any(words, HR_TITLE_PHRASES):
        return TitleClassification(role=ContactRole.HR_RECRUITER, areas=areas)
    if _has_any(words, HIRING_MANAGER_TITLE_PHRASES):
        return TitleClassification(role=ContactRole.HIRING_MANAGER, areas=areas)

    senior = isinstance(seniority, str) and seniority.strip().lower() in SENIOR_SENIORITIES
    return TitleClassification(role=ContactRole.UNKNOWN, excluded=not senior, areas=areas)


# ── Company size ──────────────────────────────────────────────────────────────
def company_size(headcount: Any) -> str:
    """"small" / "medium" / "large" from a headcount range ("11-50",
    "501-1000", "10001+", "10K+"), by its upper bound; COMPANY_SIZE_DEFAULT
    when there is none or it cannot be read (Hunter sends none today)."""
    if not isinstance(headcount, str):
        return COMPANY_SIZE_DEFAULT
    text = headcount.lower().replace(",", "")
    numbers = [int(n) * (1000 if k else 1) for n, k in re.findall(r"(\d+)\s*(k?)", text)]
    if not numbers:
        return COMPANY_SIZE_DEFAULT
    upper = max(numbers)
    if upper <= COMPANY_SIZE_SMALL_MAX:
        return SIZE_SMALL
    if upper <= COMPANY_SIZE_MEDIUM_MAX:
        return SIZE_MEDIUM
    return SIZE_LARGE


# ── Tier and confidence ───────────────────────────────────────────────────────
_EXECUTIVE_TIER_BY_SIZE = {
    SIZE_SMALL: RANK_TIER_EXECUTIVE_SMALL,
    SIZE_MEDIUM: RANK_TIER_EXECUTIVE_MEDIUM,
    SIZE_LARGE: RANK_TIER_EXECUTIVE_LARGE,
}


def tier(classification: TitleClassification, area: Optional[str], size: str) -> int:
    """Priority tier (lower is better) of a contact that is not excluded."""
    role = classification.role
    area_match = bool(area) and bool(classification.areas & set(VACANCY_AREA_CONTACT_AREAS.get(area, ())))
    if role == ContactRole.EXECUTIVE:
        return _EXECUTIVE_TIER_BY_SIZE.get(size, RANK_TIER_EXECUTIVE_MEDIUM)
    if role == ContactRole.DEPARTMENT_HEAD:
        if area_match:
            return RANK_TIER_AREA_HEAD
        if area in FINANCE_VACANCY_AREAS and "finance" in classification.areas:
            return RANK_TIER_FINANCE
        return RANK_TIER_OTHER_HEAD
    if role == ContactRole.PROCUREMENT:
        return RANK_TIER_LAST_RESORT if classification.merchandise_buyer else RANK_TIER_PROCUREMENT
    if role == ContactRole.HIRING_MANAGER:
        return RANK_TIER_AREA_MANAGER if area_match else RANK_TIER_LAST_RESORT
    if role == ContactRole.HR_RECRUITER:
        return RANK_TIER_LAST_RESORT
    return RANK_TIER_UNKNOWN_SENIOR


def verification_key(status: Any) -> Optional[str]:
    """A verification status as the ranking treats it: valid, accept_all,
    invalid, disposable, unknown (also webmail and anything unrecognized),
    or None when there is no status."""
    text = status.strip().lower() if isinstance(status, str) else ""
    if not text:
        return None
    if text in ("valid", "accept_all") or text in DROPPED_VERIFICATION_STATUSES:
        return text
    return "unknown"


def adjusted_confidence(contact: RawContact) -> Optional[float]:
    """Provider confidence x verification factor, capped for generic
    addresses; None when the address must be dropped (invalid/disposable)."""
    key = verification_key(contact.email_verification_status)
    if key in DROPPED_VERIFICATION_STATUSES:
        return None
    base = contact.provider_confidence_score
    if base is None:
        base = contact.confidence_score
    value = base * CONFIDENCE_FACTOR_BY_VERIFICATION[key]
    if contact.email_type == "generic":
        value = min(value, GENERIC_EMAIL_CONFIDENCE_CAP)
    return max(0.0, min(1.0, value))


def _seniority_rank(seniority: Any) -> int:
    if not isinstance(seniority, str):
        return SENIORITY_RANK_DEFAULT
    return SENIORITY_RANK.get(seniority.strip().lower(), SENIORITY_RANK_DEFAULT)


# ── Ranking ───────────────────────────────────────────────────────────────────
def rank_contacts(
    contacts: Sequence[RawContact], lead: LeadContext, company: Optional[CompanyInfo] = None,
) -> List[RawContact]:
    """Every deliverable contact, best first, with its role and adjusted
    confidence set. Excluded titles and invalid/disposable addresses are
    left out. Idempotent: the adjustment always starts from
    provider_confidence_score, so ranking a ranked list changes nothing."""
    area = vacancy_area(lead.job_title)
    size = company_size(company.headcount if company is not None else None)

    keyed: List[Tuple[Tuple[int, int, float, int, int], RawContact]] = []
    excluded = dropped = 0
    for index, contact in enumerate(contacts):
        classification = classify_title(contact.job_title, contact.seniority)
        if classification.excluded:
            excluded += 1
            continue
        confidence = adjusted_confidence(contact)
        if confidence is None:
            dropped += 1
            continue
        provider_confidence = contact.provider_confidence_score
        if provider_confidence is None:
            provider_confidence = contact.confidence_score
        ranked = contact.model_copy(update={
            "role": classification.role,
            "confidence_score": confidence,
            "provider_confidence_score": provider_confidence,
        })
        key = (
            tier(classification, area, size),
            _seniority_rank(contact.seniority),
            -confidence,
            VERIFICATION_RANK[verification_key(contact.email_verification_status)],
            index,
        )
        keyed.append((key, ranked))

    if excluded or dropped:
        logger.info(
            "contact_ranking: %d contact(s) excluded by title, %d dropped by email status", excluded, dropped,
        )
    keyed.sort(key=lambda item: item[0])
    return [contact for _, contact in keyed]


async def select_contacts(
    contacts: Sequence[RawContact],
    lead: LeadContext,
    company: Optional[CompanyInfo] = None,
    verifier: Any = None,
) -> List[RawContact]:
    """The RANK_TOP_N contacts to deliver. With a verifier (an object with
    `async verify_email(email)` returning a result with status /
    verified_at / source, or None), up to HUNTER_MAX_VERIFICATIONS_PER_LEAD
    top contacts whose status is not "valid" are verified first, and the
    list is ranked again (an address found invalid gives its place to the
    next one). Nothing is verified when the domain, or the address, is
    accept_all: the verifier would only answer accept_all. A verification
    that returns None or fails leaves the contact as it was."""
    ranked = rank_contacts(contacts, lead, company)
    top = ranked[:RANK_TOP_N]
    if verifier is None or (company is not None and company.accept_all):
        return top

    to_verify = [
        contact for contact in top
        if contact.email and verification_key(contact.email_verification_status) not in ("valid", "accept_all")
    ][:HUNTER_MAX_VERIFICATIONS_PER_LEAD]

    updated = {}
    for contact in to_verify:
        try:
            result = await verifier.verify_email(contact.email)
        except Exception as exc:
            logger.warning("contact_ranking: verifier failed with %s; status kept", type(exc).__name__)
            continue
        if result is None:
            continue
        updated[id(contact)] = contact.model_copy(update={
            "email_verification_status": result.status,
            "email_verified_at": result.verified_at,
            "email_verification_source": result.source,
        })
    if not updated:
        return top
    return rank_contacts([updated.get(id(contact), contact) for contact in ranked], lead, company)[:RANK_TOP_N]
