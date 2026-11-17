"""Manual contact search of one lead (Agente 2, RF15, Fase 5).

research_lead(lead, user_id, force) — called by POST
/leads/{id}/contacts/search after the router has checked that the lead is
the user's:

  1. pre-checks on the lead as read (status, running search, cooldown) —
     the same rules the transaction applies, so a refused search touches
     nothing;
  2. reuse: another lead of the same user whose last search used the same
     domain, found contacts, is less than CONTACT_REUSE_MAX_AGE_DAYS old and
     was itself a real search (not a copy) lends its contacts — no Hunter
     search. Same vacancy area required (None == None counts as the same);
     a different area is refused (409 reuse_area_mismatch) unless forced.
     `force` always searches Hunter;
  3. without reuse, a Hunter key is required (422 hunter_not_configured,
     lead untouched). A lead with neither domain nor company name makes no
     request and ends as no_domain;
  4. the search starts inside a Firestore transaction on the lead
     (LeadsRepo.try_start_contacts_search): two simultaneous clicks →
     exactly one runs, the other gets 409 search_in_progress;
  5. Hunter Domain Search (by domain, or by company name) → contacts
     rejected on this lead are removed → select_contacts ranks, verifies
     (reused contacts: also re-verifies a stale "valid") and keeps the top;
  6. the top is saved by email (update, never duplicate); unreviewed
     contacts that fell out of the top are replaced, approved and rejected
     ones are kept;
  7. LeadsRepo.finish_contacts_search writes contacts_search and the lead
     status (contacts_found when a non-rejected contact remains, else new)
     only if this search is still the lead's.

Provider failures do not raise: the search ends as state=error with a
`reason` code (invalid_api_key, rate_limited, no_credits, timeout,
provider_error, internal_error), never free text. Logs carry ids, counts,
codes and exception class names only — never names, addresses or the key.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from pydantic import ValidationError

from app.core.pipeline_constants import (
    CONTACT_REUSE_MAX_AGE_DAYS,
    CONTACT_REVERIFY_AFTER_DAYS,
    CONTACT_REVIEW_CONFIDENCE_THRESHOLD,
    CONTACT_SEARCH_COOLDOWN_SECONDS,
    CONTACT_SEARCH_TIME_BUDGET_SECONDS,
    ENRICHMENT_MAX_CONTACTS_PER_PROVIDER,
    ENRICHMENT_PROVIDER_TIMEOUT_SECONDS,
    HUNTER_COMPANY_MATCH_MIN,
)
from app.schemas.contact import ContactCreate, ReviewStatus
from app.schemas.lead import ContactsSearchState
from app.services import company_domain_service, hunter_provider
from app.services.contact_ranking_service import LeadContext, select_contacts, vacancy_area
from app.services.enrichment_service import CompanyInfo, ProviderResult, RawContact, deduplicate
from app.services.firestore_service import LeadsRepo, new_id, now_utc

logger = logging.getLogger(__name__)

# ── Reason codes (contacts_search.reason / refusal `code`) ─────────────────────
REASON_NO_DOMAIN = "no_domain_or_company_name"
REASON_NO_RESULTS = "no_results"
REASON_NO_DELIVERABLE = "no_deliverable_contacts"
REASON_COMPANY_UNMATCHED = "company_name_unmatched"
REASON_NOT_A_COMPANY = "not_a_company"
REASON_REUSED_UNUSABLE = "reused_contacts_unusable"
REASON_INVALID_API_KEY = "invalid_api_key"
REASON_RATE_LIMITED = "rate_limited"
REASON_NO_CREDITS = "no_credits"
REASON_TIMEOUT = "timeout"
REASON_PROVIDER_ERROR = "provider_error"
REASON_NOT_CONFIGURED = "hunter_not_configured"
REASON_INTERNAL_ERROR = "internal_error"

_HTTP_BY_CODE = {
    "lead_not_found": 404,
    "forbidden": 403,
    "search_in_progress": 409,
    "cooldown": 409,
    "reuse_area_mismatch": 409,
    "search_superseded": 409,
    "lead_not_searchable": 422,
    REASON_NOT_CONFIGURED: 422,
}

_MESSAGES = {
    "lead_not_found": "El lead no existe.",
    "forbidden": "Acceso denegado.",
    "search_in_progress": "Ya hay una búsqueda de contactos en curso para este lead.",
    "cooldown": "Este lead ya se buscó hace poco; espera o fuerza la búsqueda.",
    "reuse_area_mismatch": (
        "Ya se buscaron contactos de esta empresa para una vacante de otra área; "
        "fuerza la búsqueda para buscar de nuevo."
    ),
    "search_superseded": "Otra búsqueda reemplazó a esta; vuelve a cargar el lead.",
    "lead_not_searchable": "El lead está en una etapa en la que ya no se buscan contactos.",
    REASON_NOT_CONFIGURED: "Configura la clave de Hunter antes de buscar contactos.",
}


class ContactSearchRefused(Exception):
    """A search that does not start (or cannot close). `detail` holds the
    code, a fixed message and non-personal extras (ids, dates)."""

    def __init__(self, code: str, **extra: Any):
        super().__init__(code)
        self.code = code
        self.status_code = _HTTP_BY_CODE.get(code, 409)
        self.detail = {"code": code, "message": _MESSAGES.get(code, code), **extra}


def reason_for_exception(exc: BaseException) -> str:
    if isinstance(exc, hunter_provider.HunterAuthError):
        return REASON_INVALID_API_KEY
    if isinstance(exc, hunter_provider.HunterRateLimitError):
        return REASON_RATE_LIMITED
    if isinstance(exc, hunter_provider.HunterNoCreditsError):
        return REASON_NO_CREDITS
    if isinstance(exc, hunter_provider.HunterNotConfiguredError):
        return REASON_NOT_CONFIGURED
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):  # HunterTimeoutError too
        return REASON_TIMEOUT
    if isinstance(exc, hunter_provider.HunterError):
        return REASON_PROVIDER_ERROR
    return REASON_INTERNAL_ERROR


# ── Pure helpers ──────────────────────────────────────────────────────────────
def _as_utc(value: Any) -> Optional[datetime]:
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _field(obj: Any, name: str) -> Any:
    return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)


def contact_key(contact: Any) -> Tuple[str, ...]:
    """Identity of a contact within a lead: the email (case-insensitive), or
    name + title when there is none — same rule as enrichment_service.dedupe_key,
    for both RawContact objects and stored dicts."""
    email = _field(contact, "email")
    if isinstance(email, str) and email.strip():
        return ("email", email.strip().lower())
    name = " ".join(str(_field(contact, "full_name") or "").lower().split())
    title = " ".join(str(_field(contact, "job_title") or "").lower().split())
    return ("name", name, title)


def review_status_of(contact: Dict[str, Any]) -> str:
    return contact.get("review_status") or ReviewStatus.NOT_REQUIRED.value


def review_for_confidence(confidence: float) -> str:
    if confidence < CONTACT_REVIEW_CONFIDENCE_THRESHOLD:
        return ReviewStatus.PENDING.value
    return ReviewStatus.NOT_REQUIRED.value


# Allowed review transitions: decision → statuses it may be applied to.
_REVIEW_FROM = {
    ReviewStatus.REJECTED.value: (
        ReviewStatus.NOT_REQUIRED.value, ReviewStatus.PENDING.value, ReviewStatus.APPROVED.value,
    ),
    ReviewStatus.APPROVED.value: (ReviewStatus.PENDING.value, ReviewStatus.REJECTED.value),
}


def review_allowed(current: str, decision: str) -> bool:
    return current in _REVIEW_FROM.get(decision, ())


def sort_contacts(contacts: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ranked contacts first (rank 1, 2, 3), then the rest by confidence."""
    def key(contact: Dict[str, Any]):
        rank = contact.get("rank")
        ranked = isinstance(rank, int) and not isinstance(rank, bool)
        return (0 if ranked else 1, rank if ranked else 0, -(contact.get("confidence_score") or 0.0))

    return sorted(contacts, key=key)


def visible_contacts(contacts: Iterable[Dict[str, Any]], include_rejected: bool = False) -> List[Dict[str, Any]]:
    items = [c for c in contacts if include_rejected or review_status_of(c) != ReviewStatus.REJECTED.value]
    return sort_contacts(items)


def choose_reuse_source(
    candidates: Iterable[Dict[str, Any]],
    lead_id: str,
    user_id: str,
    domain: str,
    area: Optional[str],
    now: datetime,
) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """("reuse", lead) with the most recent reusable search of the same
    area, ("area_mismatch", lead) when the only reusable ones are of
    another area, or (None, None). A candidate must belong to `user_id` —
    checked here again, whatever the query returned — and be a real
    search (not a copy) that found contacts less than
    CONTACT_REUSE_MAX_AGE_DAYS ago with this domain."""
    oldest = now - timedelta(days=CONTACT_REUSE_MAX_AGE_DAYS)
    same_area: List[Tuple[datetime, Dict[str, Any]]] = []
    other_area: List[Tuple[datetime, Dict[str, Any]]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict) or candidate.get("user_id") != user_id:
            continue
        if candidate.get("id") == lead_id:
            continue
        search = candidate.get("contacts_search") or {}
        searched_at = _as_utc(search.get("searched_at"))
        if (
            search.get("state") != ContactsSearchState.CONTACTS_FOUND.value
            or search.get("reused_from_lead_id")
            or search.get("domain") != domain
            or searched_at is None
            or searched_at < oldest
        ):
            continue
        (same_area if search.get("vacancy_area") == area else other_area).append((searched_at, candidate))
    if same_area:
        return "reuse", max(same_area, key=lambda item: item[0])[1]
    if other_area:
        return "area_mismatch", max(other_area, key=lambda item: item[0])[1]
    return None, None


def _unpack(result: Any) -> Tuple[List[RawContact], Optional[CompanyInfo]]:
    if isinstance(result, ProviderResult):
        items, company = result.contacts, result.company
    elif isinstance(result, list):
        items, company = result, None
    else:
        raise TypeError("invalid provider result")
    contacts = [c for c in items if isinstance(c, RawContact)][:ENRICHMENT_MAX_CONTACTS_PER_PROVIDER]
    return deduplicate(contacts), company if isinstance(company, CompanyInfo) else None


class _Outcome:
    def __init__(self, state: ContactsSearchState, reason: Optional[str] = None, **fields: Any):
        self.state = state
        self.reason = reason
        self.domain = fields.get("domain")
        self.domain_source = fields.get("domain_source")
        self.query_type = fields.get("query_type")
        self.contacts_count = fields.get("contacts_count", 0)
        self.reused_from_lead_id = fields.get("reused_from_lead_id")


# ── Service ───────────────────────────────────────────────────────────────────
class ContactResearchService:
    def __init__(
        self,
        leads_repo: Any,
        contacts_repo: Any,
        pipeline_configs_repo: Any,
        provider_factory: Callable[[Dict[str, Any]], Any] = hunter_provider.from_pipeline_config,
        clock: Callable[[], datetime] = now_utc,
        time_budget_seconds: float = CONTACT_SEARCH_TIME_BUDGET_SECONDS,
        provider_timeout_seconds: float = ENRICHMENT_PROVIDER_TIMEOUT_SECONDS,
    ):
        self.leads = leads_repo
        self.contacts = contacts_repo
        self.pipeline_configs = pipeline_configs_repo
        self.provider_factory = provider_factory
        self.clock = clock
        self.time_budget_seconds = time_budget_seconds
        self.provider_timeout_seconds = provider_timeout_seconds

    # ── Listing ───────────────────────────────────────────────────────────────
    async def list_contacts(self, lead_id: str, user_id: str, include_rejected: bool = False) -> List[Dict[str, Any]]:
        contacts = await self.contacts.list_by_lead(lead_id, user_id)
        mine = [c for c in contacts if c.get("user_id") == user_id and c.get("lead_id") == lead_id]
        return visible_contacts(mine, include_rejected)

    # ── Search ────────────────────────────────────────────────────────────────
    async def research_lead(self, lead: Dict[str, Any], user_id: str, *, force: bool = False) -> Dict[str, Any]:
        lead_id = lead["id"]
        now = self.clock()
        precheck = LeadsRepo.plan_contacts_search_start(lead, user_id, now, force)
        if not precheck["started"]:
            raise self._refusal(precheck)

        company_name = (lead.get("company_name") or "").strip()
        job_title = (lead.get("job_title") or "").strip()
        domain = company_domain_service.normalize_domain(lead.get("company_domain")) if lead.get("company_domain") else None
        area = vacancy_area(job_title)

        reuse_source = None
        if domain and not force:
            candidates = await self.leads.list_by_contacts_domain(user_id, domain)
            kind, source = choose_reuse_source(candidates, lead_id, user_id, domain, area, now)
            if kind == "area_mismatch":
                raise ContactSearchRefused("reuse_area_mismatch", reused_from_lead_id=source["id"])
            reuse_source = source if kind == "reuse" else None

        provider = None
        needs_search = reuse_source is None and bool(domain or company_name)
        if needs_search or reuse_source is not None:
            config = await self.pipeline_configs.get_by_user(user_id) or {}
            provider = self.provider_factory(config)
            if provider is None and needs_search:
                raise ContactSearchRefused(REASON_NOT_CONFIGURED)

        search_id = new_id()
        started = await self.leads.try_start_contacts_search(lead_id, user_id, search_id, force, now)
        if not started["started"]:
            raise self._refusal(started)
        if started.get("stale_search_id"):
            logger.warning(
                "contact_research: lead %s search %s presumed dead; taken over by %s",
                lead_id, started["stale_search_id"], search_id,
            )

        context = LeadContext(job_title=job_title, company_name=company_name, company_domain=domain)
        try:
            outcome = await asyncio.wait_for(
                self._run(lead_id, user_id, search_id, context, provider, reuse_source, now),
                timeout=self.time_budget_seconds,
            )
        except Exception as exc:  # the overall budget, or a bug: the lead must not stay "running"
            reason = reason_for_exception(exc)
            logger.warning("contact_research: lead %s search %s failed (%s)", lead_id, search_id, type(exc).__name__)
            outcome = _Outcome(ContactsSearchState.ERROR, reason, domain=domain)

        contacts = await self.list_contacts(lead_id, user_id)
        lead_status = "contacts_found" if contacts else "new"
        searched_at = self.clock()
        credits_used = float(getattr(provider, "credits_spent", 0.0) or 0.0) if provider is not None else 0.0
        contacts_search = {
            "state": outcome.state.value,
            "search_id": search_id,
            "started_at": now,
            "searched_at": searched_at,
            "reason": outcome.reason,
            "domain": outcome.domain,
            "domain_source": outcome.domain_source,
            "query_type": outcome.query_type,
            "vacancy_area": area,
            "contacts_count": outcome.contacts_count,
            "credits_used": credits_used,
            "forced": force,
            "reused_from_lead_id": outcome.reused_from_lead_id,
        }
        if not await self.leads.finish_contacts_search(lead_id, search_id, lead_status, contacts_search, searched_at):
            logger.warning("contact_research: lead %s search %s superseded; result not written", lead_id, search_id)
            raise ContactSearchRefused("search_superseded")

        logger.info(
            "contact_research: lead %s search %s → %s (%s), %d delivered, %.1f credit(s), reused=%s",
            lead_id, search_id, outcome.state.value, outcome.reason, outcome.contacts_count, credits_used,
            bool(outcome.reused_from_lead_id),
        )
        cooled = outcome.state.value in LeadsRepo.COOLDOWN_STATES
        return {
            "lead_id": lead_id,
            "search_id": search_id,
            "state": outcome.state.value,
            "reason": outcome.reason,
            "lead_status": lead_status,
            "contacts": contacts,
            "credits_used": credits_used,
            "credits_remaining": getattr(provider, "credits_remaining", None) if provider is not None else None,
            "reused": bool(outcome.reused_from_lead_id),
            "reused_from_lead_id": outcome.reused_from_lead_id,
            "searched_at": searched_at,
            "next_search_allowed_at": (
                searched_at + timedelta(seconds=CONTACT_SEARCH_COOLDOWN_SECONDS) if cooled else None
            ),
        }

    @staticmethod
    def _refusal(plan: Dict[str, Any]) -> ContactSearchRefused:
        extra = {}
        if plan.get("next_search_allowed_at") is not None:
            extra["next_search_allowed_at"] = plan["next_search_allowed_at"].isoformat()
        return ContactSearchRefused(plan["code"], **extra)

    async def _run(
        self,
        lead_id: str,
        user_id: str,
        search_id: str,
        context: LeadContext,
        provider: Any,
        reuse_source: Optional[Dict[str, Any]],
        now: datetime,
    ) -> _Outcome:
        existing = [
            c for c in await self.contacts.list_by_lead(lead_id, user_id)
            if c.get("user_id") == user_id and c.get("lead_id") == lead_id
        ]
        rejected = {contact_key(c) for c in existing if review_status_of(c) == ReviewStatus.REJECTED.value}

        if reuse_source is not None:
            return await self._reuse(
                lead_id, user_id, search_id, context, provider, reuse_source, existing, rejected, now,
            )

        domain = context.company_domain
        if not domain and not context.company_name:
            return _Outcome(ContactsSearchState.NO_DOMAIN, REASON_NO_DOMAIN)

        query_type = "domain" if domain else "company"
        try:
            result = await asyncio.wait_for(
                provider.search(context.company_name, context.job_title, domain=domain),
                timeout=self.provider_timeout_seconds,
            )
            found, company = _unpack(result)
        except Exception as exc:
            reason = reason_for_exception(exc)
            logger.warning("contact_research: lead %s provider failed (%s)", lead_id, type(exc).__name__)
            return _Outcome(ContactsSearchState.ERROR, reason, domain=domain,
                            domain_source="lead" if domain else None, query_type=query_type)

        used_domain, domain_source, reason = domain, ("lead" if domain else None), None
        if not domain:
            resolved = company_domain_service.normalize_domain(company.domain) if company and company.domain else None
            if resolved and hunter_provider.company_name_match(resolved, context.company_name) >= HUNTER_COMPANY_MATCH_MIN:
                used_domain, domain_source = resolved, "hunter_company_search"
            elif resolved and not found:
                reason = REASON_COMPANY_UNMATCHED
        if company is not None and (company.disposable or company.webmail):
            reason = REASON_NOT_A_COMPANY

        candidates = [c for c in found if contact_key(c) not in rejected]
        ranked_context = context.model_copy(update={"company_domain": used_domain})
        top = await select_contacts(candidates, ranked_context, company, verifier=provider)
        await self._save(lead_id, user_id, search_id, top, existing, now)

        if top:
            state, reason = ContactsSearchState.CONTACTS_FOUND, None
        else:
            state = ContactsSearchState.NO_CONTACTS
            reason = reason or (REASON_NO_DELIVERABLE if found else REASON_NO_RESULTS)
        logger.info(
            "contact_research: lead %s: %d found, %d rejected before, %d delivered",
            lead_id, len(found), len(found) - len(candidates), len(top),
        )
        return _Outcome(state, reason, domain=used_domain, domain_source=domain_source,
                        query_type=query_type, contacts_count=len(top))

    async def _reuse(
        self,
        lead_id: str,
        user_id: str,
        search_id: str,
        context: LeadContext,
        provider: Any,
        source: Dict[str, Any],
        existing: List[Dict[str, Any]],
        rejected: set,
        now: datetime,
    ) -> _Outcome:
        source_id = source["id"]
        source_contacts = await self.contacts.list_by_lead(source_id, user_id)
        origin: Dict[Tuple[str, ...], str] = {}
        raws: List[RawContact] = []
        for stored in source_contacts:
            if stored.get("user_id") != user_id or stored.get("lead_id") != source_id:
                continue
            if review_status_of(stored) == ReviewStatus.REJECTED.value:
                continue  # rejected on the source lead: never copied
            key = contact_key(stored)
            if key in rejected or key in origin:
                continue
            try:
                raws.append(RawContact.model_validate(stored))
            except ValidationError:
                continue
            origin[key] = stored.get("id")

        top = await select_contacts(
            raws, context, None, verifier=provider,
            reverify_verified_before=now - timedelta(days=CONTACT_REVERIFY_AFTER_DAYS),
        )
        await self._save(lead_id, user_id, search_id, top, existing, now,
                         reused_from_lead_id=source_id, origin=origin)
        logger.info(
            "contact_research: lead %s reused %d of %d contact(s) from lead %s",
            lead_id, len(top), len(source_contacts), source_id,
        )
        source_search = source.get("contacts_search") or {}
        state = ContactsSearchState.CONTACTS_FOUND if top else ContactsSearchState.NO_CONTACTS
        return _Outcome(
            state, None if top else REASON_REUSED_UNUSABLE,
            domain=context.company_domain, domain_source=source_search.get("domain_source") or "lead",
            query_type="reuse", contacts_count=len(top), reused_from_lead_id=source_id,
        )

    async def _save(
        self,
        lead_id: str,
        user_id: str,
        search_id: str,
        top: List[RawContact],
        existing: List[Dict[str, Any]],
        now: datetime,
        reused_from_lead_id: Optional[str] = None,
        origin: Optional[Dict[Tuple[str, ...], str]] = None,
    ) -> None:
        """Upsert the top by contact_key; replace unreviewed contacts that
        left the top; keep approved (unranked) and rejected ones."""
        by_key = {contact_key(c): c for c in existing}
        in_top = set()
        for rank, contact in enumerate(top, start=1):
            key = contact_key(contact)
            in_top.add(key)
            create = ContactCreate.model_validate(contact.model_dump())
            extra = {
                "rank": rank,
                "search_id": search_id,
                "reused_from_lead_id": reused_from_lead_id,
                "reused_from_contact_id": (origin or {}).get(key) if reused_from_lead_id else None,
            }
            current = by_key.get(key)
            if current is None:
                extra.update(review_status=review_for_confidence(contact.confidence_score), reviewed_at=None)
                await self.contacts.create_for_lead(lead_id, user_id, create, extra=extra)
                continue
            status = review_status_of(current)
            if status not in (ReviewStatus.APPROVED.value, ReviewStatus.REJECTED.value):
                extra["review_status"] = review_for_confidence(contact.confidence_score)
            await self.contacts.update(current["id"], {**create.model_dump(mode="json"), **extra})

        for key, current in by_key.items():
            if key in in_top:
                continue
            status = review_status_of(current)
            if status in (ReviewStatus.NOT_REQUIRED.value, ReviewStatus.PENDING.value):
                await self.contacts.delete(current["id"])
            elif status == ReviewStatus.APPROVED.value and current.get("rank") is not None:
                await self.contacts.update(current["id"], {"rank": None})


_service: Optional[ContactResearchService] = None


def get_service() -> ContactResearchService:
    """The service wired to the Firestore repositories (tests replace it)."""
    global _service
    if _service is None:
        from app.services.firestore_service import contacts_repo, leads_repo, pipeline_configs_repo

        _service = ContactResearchService(leads_repo, contacts_repo, pipeline_configs_repo)
    return _service
