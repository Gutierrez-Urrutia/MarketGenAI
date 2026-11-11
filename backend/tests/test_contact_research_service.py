"""contact_research_service (RF15, Fase 5): manual contact search of one lead.

In-memory repositories and a fake provider; synthetic data only (reserved
example.com / example.org / example.net domains, invented names). No
network: no Hunter, Firestore or DNS call is made.
"""
from __future__ import annotations

import asyncio
import copy
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

import pytest

from app.core.pipeline_constants import (
    CONTACT_REUSE_MAX_AGE_DAYS,
    CONTACT_SEARCH_CONSIDERED_DEAD_AFTER_SECONDS,
    CONTACT_SEARCH_COOLDOWN_SECONDS,
)
from app.services import hunter_provider
from app.services.contact_ranking_service import LeadContext, select_contacts, vacancy_area
from app.services.contact_research_service import (
    ContactResearchService,
    ContactSearchRefused,
    choose_reuse_source,
    contact_key,
    review_allowed,
    sort_contacts,
)
from app.services.enrichment_service import CompanyInfo, ProviderResult, RawContact
from app.services.firestore_service import LeadsRepo
from app.services.hunter_provider import EmailVerification, HunterProvider
from tests.conftest import FAKE_USER_SUB

USER = FAKE_USER_SUB
OTHER = "other-user-sub-999"
NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
SUPPORT_TITLE = "Customer Support Agent"


# ── Fakes ─────────────────────────────────────────────────────────────────────
class FakeLeads:
    """Mirrors LeadsRepo's contact-search methods, using its pure rules.
    try_start is serialized like a Firestore transaction. The domain query
    deliberately ignores user_id: the service must filter again."""

    def __init__(self, *leads: Dict[str, Any]):
        self.docs = {lead["id"]: copy.deepcopy(lead) for lead in leads}
        self._lock = asyncio.Lock()
        self.finish_calls = 0

    async def list_by_contacts_domain(self, user_id: str, domain: str) -> List[Dict[str, Any]]:
        return [copy.deepcopy(d) for d in self.docs.values() if (d.get("contacts_search") or {}).get("domain") == domain]

    async def try_start_contacts_search(self, lead_id, user_id, search_id, force, now):
        async with self._lock:
            lead = self.docs.get(lead_id)
            snapshot = copy.deepcopy(lead)
            await asyncio.sleep(0)
            plan = LeadsRepo.plan_contacts_search_start(snapshot, user_id, now, force)
            if plan["started"]:
                lead.update(LeadsRepo.contacts_search_start_fields(search_id, now, force))
            return plan

    async def recompute_status_after_review(self, lead_id, user_id, has_active, now):
        lead = self.docs.get(lead_id)
        if lead is None:
            return None
        target = LeadsRepo.plan_status_after_review(lead, user_id, has_active)
        if target is not None:
            lead["status"] = target
        return lead.get("status") or "new"

    async def finish_contacts_search(self, lead_id, search_id, status, contacts_search, now):
        self.finish_calls += 1
        lead = self.docs[lead_id]
        if not LeadsRepo.can_finish_contacts_search(lead, search_id):
            return False
        lead.update(status=status, contacts_search=copy.deepcopy(contacts_search))
        return True


class FakeContacts:
    def __init__(self, *contacts: Dict[str, Any]):
        self.docs = {c["id"]: copy.deepcopy(c) for c in contacts}
        self._next = 0

    def of(self, lead_id: str) -> List[Dict[str, Any]]:
        return [c for c in self.docs.values() if c["lead_id"] == lead_id]

    async def list_by_lead(self, lead_id, user_id, limit=100):
        return [copy.deepcopy(c) for c in self.docs.values() if c["lead_id"] == lead_id and c["user_id"] == user_id]

    async def create_for_lead(self, lead_id, user_id, contact, extra=None):
        self._next += 1
        doc = {**contact.model_dump(mode="json"), **(extra or {}), "lead_id": lead_id, "user_id": user_id,
               "id": f"new-{self._next}"}
        self.docs[doc["id"]] = doc
        return copy.deepcopy(doc)

    async def update(self, contact_id, data):
        self.docs[contact_id].update(copy.deepcopy(data))
        return copy.deepcopy(self.docs[contact_id])

    async def delete(self, contact_id):
        del self.docs[contact_id]

    async def get(self, contact_id):
        return copy.deepcopy(self.docs.get(contact_id))


class FakeConfigs:
    def __init__(self, configured: bool = True):
        self.configured = configured

    async def get_by_user(self, user_id):
        return {"id": user_id, "hunter_api_key_encrypted": "token-sintetico"} if self.configured else {"id": user_id}


class FakeProvider:
    name = "hunter"

    def __init__(self, contacts=(), company=None, exc=None, delay=0.0, verify=None, on_search=None):
        self.result = ProviderResult(contacts=list(contacts), company=company)
        self.exc = exc
        self.delay = delay
        self.verify = verify
        self.on_search = on_search
        self.calls: List[tuple] = []
        self.verify_calls: List[str] = []
        self.credits_spent = 0.0
        self.credits_remaining: Optional[float] = 40.0

    async def search(self, company, job_context, *, domain=None):
        self.calls.append((company, job_context, domain))
        if self.on_search:
            self.on_search()
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc is not None:
            raise self.exc
        if self.result.contacts:
            self.credits_spent += 1.0
            self.credits_remaining -= 1.0
        return self.result

    async def verify_email(self, email):
        self.verify_calls.append(email)
        self.credits_spent += 0.5
        self.credits_remaining -= 0.5
        return self.verify(email) if self.verify else None


class Clock:
    def __init__(self, now: datetime = NOW):
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def make_service(leads, contacts, provider=None, configured=True, clock=None, **kwargs):
    factory_calls = []

    def factory(config):
        factory_calls.append(config)
        return provider if config.get("hunter_api_key_encrypted") else None

    service = ContactResearchService(
        leads, contacts, FakeConfigs(configured), provider_factory=factory, clock=clock or Clock(), **kwargs,
    )
    service.factory_calls = factory_calls
    return service


# ── Synthetic data ────────────────────────────────────────────────────────────
def make_lead(lead_id="lead-1", *, user=USER, domain: Optional[str] = "example.com", company="Example Services",
              title=SUPPORT_TITLE, status="new", search=None) -> Dict[str, Any]:
    lead = {
        "id": lead_id, "user_id": user, "pipeline_config_id": user, "job_title": title, "company_name": company,
        "job_description": "", "job_url": "", "source_id": "source-1", "status": status,
        "pipeline_run_id": "run-1", "fingerprint": f"fp-{lead_id}", "company_domain": domain,
    }
    if search is not None:
        lead["contacts_search"] = search
    return lead


def found_search(domain="example.com", *, days_ago=1.0, area="customer_service", state="contacts_found",
                 reused_from=None) -> Dict[str, Any]:
    return {
        "state": state, "search_id": "old-search", "started_at": NOW - timedelta(days=days_ago),
        "searched_at": NOW - timedelta(days=days_ago), "domain": domain, "domain_source": "lead",
        "query_type": "domain", "vacancy_area": area, "contacts_count": 3, "reused_from_lead_id": reused_from,
    }


def raw(name, title, email, *, conf=0.9, status="valid", seniority="executive", verified_at=None) -> RawContact:
    return RawContact(
        full_name=name, job_title=title, company="Example Services", email=email, source="hunter",
        confidence_score=conf, provider_confidence_score=conf, email_type="personal",
        email_verification_status=status, email_verified_at=verified_at, seniority=seniority,
        email_verification_source="hunter_domain_search" if status else None,
    )


ANA = raw("Ana Ficticia", "Head of Customer Service", "ana.ficticia@example.com")
BRUNO = raw("Bruno Inventado", "Chief Executive Officer", "bruno.inventado@example.com")
CARLA = raw("Carla Sintetica", "Procurement Manager", "carla.sintetica@example.com", conf=0.4)
DIEGO = raw("Diego Prueba", "Operations Director", "diego.prueba@example.com", seniority="senior")
DRIVER = raw("Elena Ejemplo", "Delivery Driver", "elena.ejemplo@example.com")


def stored(contact_id, lead_id, contact: RawContact, *, user=USER, review="not_required", rank=None,
           **extra) -> Dict[str, Any]:
    return {
        **contact.model_dump(mode="json"), "id": contact_id, "lead_id": lead_id, "user_id": user,
        "verified": False, "review_status": review, "rank": rank, "search_id": "old-search",
        "reused_from_lead_id": None, "reused_from_contact_id": None, **extra,
    }


def emails(contacts) -> set:
    return {c["email"] for c in contacts}


# ── Success / search modes ────────────────────────────────────────────────────
async def test_success_saves_top3_ranked_with_review_by_confidence():
    leads, contacts = FakeLeads(make_lead()), FakeContacts()
    provider = FakeProvider([ANA, BRUNO, CARLA, DRIVER])
    result = await make_service(leads, contacts, provider).research_lead(make_lead(), USER)

    assert provider.calls == [("Example Services", SUPPORT_TITLE, "example.com")]
    saved = contacts.of("lead-1")
    assert len(saved) == 3 and DRIVER.email not in emails(saved)
    assert sorted(c["rank"] for c in saved) == [1, 2, 3]
    review = {c["email"]: c["review_status"] for c in saved}
    assert review[CARLA.email] == "pending"            # 0.4 < 0.5
    assert review[ANA.email] == review[BRUNO.email] == "not_required"
    assert all(c["user_id"] == USER and c["lead_id"] == "lead-1" for c in saved)

    assert result["state"] == "contacts_found" and result["lead_status"] == "contacts_found"
    assert [c["rank"] for c in result["contacts"]] == [1, 2, 3]
    assert result["credits_used"] == 1.0 and result["credits_remaining"] == 39.0
    assert result["reused"] is False
    assert result["next_search_allowed_at"] == NOW + timedelta(seconds=CONTACT_SEARCH_COOLDOWN_SECONDS)

    lead = leads.docs["lead-1"]
    assert lead["status"] == "contacts_found"
    search = lead["contacts_search"]
    assert search["state"] == "contacts_found" and search["domain"] == "example.com"
    assert search["domain_source"] == "lead" and search["query_type"] == "domain"
    assert search["vacancy_area"] == vacancy_area(SUPPORT_TITLE) and search["contacts_count"] == 3


async def test_search_by_company_name_stores_resolved_domain_without_touching_company_domain():
    lead = make_lead(domain=None)
    leads, contacts = FakeLeads(lead), FakeContacts()
    provider = FakeProvider([ANA], company=CompanyInfo(domain="example.org", organization="Example"))
    result = await make_service(leads, contacts, provider).research_lead(lead, USER)

    assert provider.calls == [("Example Services", SUPPORT_TITLE, None)]
    search = leads.docs["lead-1"]["contacts_search"]
    assert search["domain"] == "example.org"
    assert search["domain_source"] == "hunter_company_search" and search["query_type"] == "company"
    assert leads.docs["lead-1"]["company_domain"] is None
    assert result["state"] == "contacts_found"


async def test_company_name_search_resolving_to_unrelated_domain_is_marked():
    lead = make_lead(domain=None)
    leads = FakeLeads(lead)
    provider = FakeProvider([], company=CompanyInfo(domain="unrelated.net"))
    result = await make_service(leads, FakeContacts(), provider).research_lead(lead, USER)

    assert result["state"] == "no_contacts" and result["reason"] == "company_name_unmatched"
    assert leads.docs["lead-1"]["contacts_search"]["domain"] is None


async def test_without_domain_nor_name_no_request_is_made():
    lead = make_lead(domain=None, company="")
    leads = FakeLeads(lead)
    provider = FakeProvider([ANA])
    service = make_service(leads, FakeContacts(), provider, configured=False)
    result = await service.research_lead(lead, USER)

    assert provider.calls == [] and service.factory_calls == []
    assert result["state"] == "no_domain" and result["reason"] == "no_domain_or_company_name"
    assert result["lead_status"] == "new" and leads.docs["lead-1"]["status"] == "new"
    assert result["next_search_allowed_at"] is None


async def test_no_contacts_keeps_the_lead_marked_not_discarded():
    leads = FakeLeads(make_lead())
    result = await make_service(leads, FakeContacts(), FakeProvider([])).research_lead(make_lead(), USER)

    assert result["state"] == "no_contacts" and result["reason"] == "no_results"
    assert result["credits_used"] == 0.0
    assert leads.docs["lead-1"]["status"] == "new"
    assert leads.docs["lead-1"]["contacts_search"]["state"] == "no_contacts"


async def test_only_operational_staff_delivers_nothing():
    contacts = FakeContacts()
    result = await make_service(FakeLeads(make_lead()), contacts, FakeProvider([DRIVER])).research_lead(make_lead(), USER)

    assert result["state"] == "no_contacts" and result["reason"] == "no_deliverable_contacts"
    assert contacts.docs == {}


# ── Provider failures ─────────────────────────────────────────────────────────
@pytest.mark.parametrize("exc, reason", [
    (hunter_provider.HunterAuthError(), "invalid_api_key"),
    (hunter_provider.HunterRateLimitError(), "rate_limited"),
    (hunter_provider.HunterNoCreditsError(), "no_credits"),
    (hunter_provider.HunterTimeoutError(), "timeout"),
    (hunter_provider.HunterHTTPError(), "provider_error"),
    (hunter_provider.HunterResponseError(), "provider_error"),
    (RuntimeError("Ana Ficticia ana.ficticia@example.com"), "internal_error"),
])
async def test_provider_failure_ends_as_error_with_a_reason_code(exc, reason):
    leads, contacts = FakeLeads(make_lead()), FakeContacts()
    result = await make_service(leads, contacts, FakeProvider(exc=exc)).research_lead(make_lead(), USER)

    assert result["state"] == "error" and result["reason"] == reason
    assert result["lead_status"] == "new" and result["next_search_allowed_at"] is None
    assert leads.docs["lead-1"]["contacts_search"]["state"] == "error"
    assert "ficticia" not in str(leads.docs["lead-1"]).lower()
    assert contacts.docs == {}


async def test_provider_slower_than_its_budget_is_a_timeout():
    leads = FakeLeads(make_lead())
    service = make_service(leads, FakeContacts(), FakeProvider([ANA], delay=1.0), provider_timeout_seconds=0.01)
    result = await service.research_lead(make_lead(), USER)
    assert result["state"] == "error" and result["reason"] == "timeout"


async def test_whole_request_budget_ends_as_timeout_and_frees_the_lead():
    leads = FakeLeads(make_lead())
    service = make_service(leads, FakeContacts(), FakeProvider([ANA], delay=1.0), time_budget_seconds=0.01)
    result = await service.research_lead(make_lead(), USER)
    assert result["state"] == "error" and result["reason"] == "timeout"
    assert leads.docs["lead-1"]["contacts_search"]["state"] != "running"


async def test_error_keeps_contacts_found_status_when_the_lead_already_had_contacts():
    lead = make_lead(status="contacts_found", search=found_search(days_ago=2))
    contacts = FakeContacts(stored("c-1", "lead-1", ANA, review="approved", rank=1))
    leads = FakeLeads(lead)
    result = await make_service(leads, contacts, FakeProvider(exc=hunter_provider.HunterNoCreditsError())).research_lead(lead, USER)
    assert result["state"] == "error" and result["lead_status"] == "contacts_found"


async def test_missing_key_is_refused_without_touching_the_lead():
    lead = make_lead()
    leads = FakeLeads(lead)
    with pytest.raises(ContactSearchRefused) as info:
        await make_service(leads, FakeContacts(), FakeProvider([ANA]), configured=False).research_lead(lead, USER)
    assert info.value.code == "hunter_not_configured" and info.value.status_code == 422
    assert leads.docs["lead-1"] == lead


# ── Lock, cooldown, stuck search ──────────────────────────────────────────────
async def test_two_simultaneous_clicks_start_exactly_one_search():
    lead = make_lead()
    leads, contacts = FakeLeads(lead), FakeContacts()
    provider = FakeProvider([ANA, BRUNO], delay=0.05)
    service = make_service(leads, contacts, provider)

    results = await asyncio.gather(
        service.research_lead(lead, USER), service.research_lead(lead, USER), return_exceptions=True,
    )
    refused = [r for r in results if isinstance(r, ContactSearchRefused)]
    done = [r for r in results if isinstance(r, dict)]
    assert len(done) == 1 and len(refused) == 1
    assert refused[0].code == "search_in_progress" and refused[0].status_code == 409
    assert len(provider.calls) == 1
    assert len(contacts.docs) == 2


async def test_cooldown_refuses_a_repeat_and_force_overrides_it():
    lead = make_lead(status="contacts_found", search=found_search(days_ago=1 / 24))
    leads, provider = FakeLeads(lead), FakeProvider([ANA])
    service = make_service(leads, FakeContacts(), provider)

    with pytest.raises(ContactSearchRefused) as info:
        await service.research_lead(lead, USER)
    assert info.value.code == "cooldown" and info.value.status_code == 409
    expected = (NOW - timedelta(hours=1) + timedelta(seconds=CONTACT_SEARCH_COOLDOWN_SECONDS)).isoformat()
    assert info.value.detail["next_search_allowed_at"] == expected
    assert provider.calls == []

    result = await service.research_lead(lead, USER, force=True)
    assert len(provider.calls) == 1 and result["state"] == "contacts_found"
    assert leads.docs["lead-1"]["contacts_search"]["forced"] is True


async def test_cooldown_ends_after_the_period():
    lead = make_lead(status="contacts_found", search=found_search(days_ago=1.05))
    provider = FakeProvider([ANA])
    await make_service(FakeLeads(lead), FakeContacts(), provider).research_lead(lead, USER)
    assert len(provider.calls) == 1


async def test_an_error_is_not_cooled_down():
    lead = make_lead(search=found_search(days_ago=0.01, state="error"))
    provider = FakeProvider([ANA])
    await make_service(FakeLeads(lead), FakeContacts(), provider).research_lead(lead, USER)
    assert len(provider.calls) == 1


async def test_stuck_researching_lead_is_taken_over_after_the_threshold():
    stuck = {"state": "running", "search_id": "dead-search",
             "started_at": NOW - timedelta(seconds=CONTACT_SEARCH_CONSIDERED_DEAD_AFTER_SECONDS + 1)}
    lead = make_lead(status="researching", search=stuck)
    leads = FakeLeads(lead)
    result = await make_service(leads, FakeContacts(), FakeProvider([ANA])).research_lead(lead, USER)
    assert result["state"] == "contacts_found"
    assert leads.docs["lead-1"]["contacts_search"]["search_id"] != "dead-search"


async def test_live_running_search_blocks_a_new_one():
    live = {"state": "running", "search_id": "live", "started_at": NOW - timedelta(seconds=30)}
    lead = make_lead(status="researching", search=live)
    with pytest.raises(ContactSearchRefused) as info:
        await make_service(FakeLeads(lead), FakeContacts(), FakeProvider([ANA])).research_lead(lead, USER, force=True)
    assert info.value.code == "search_in_progress"


@pytest.mark.parametrize("lead_status", [
    "composing", "ready_for_review", "approved", "sent", "replied", "rejected",
])
async def test_later_stages_are_not_searchable(lead_status):
    lead = make_lead(status=lead_status)
    with pytest.raises(ContactSearchRefused) as info:
        await make_service(FakeLeads(lead), FakeContacts(), FakeProvider([ANA])).research_lead(lead, USER, force=True)
    assert info.value.code == "lead_not_searchable" and info.value.status_code == 422


@pytest.mark.parametrize("lead_status", ["new", "contacts_found", "error"])
async def test_searchable_statuses(lead_status):
    lead = make_lead(status=lead_status)
    result = await make_service(FakeLeads(lead), FakeContacts(), FakeProvider([ANA])).research_lead(lead, USER)
    assert result["state"] == "contacts_found"


async def test_finish_with_an_old_search_id_does_not_overwrite():
    lead = make_lead()
    leads, contacts = FakeLeads(lead), FakeContacts()

    def taken_over():  # another search took the lead over while this one ran
        leads.docs["lead-1"]["contacts_search"] = {"state": "running", "search_id": "newer", "started_at": NOW}

    with pytest.raises(ContactSearchRefused) as info:
        await make_service(leads, contacts, FakeProvider([ANA], on_search=taken_over)).research_lead(lead, USER)
    assert info.value.code == "search_superseded"
    assert leads.docs["lead-1"]["contacts_search"] == {"state": "running", "search_id": "newer", "started_at": NOW}
    assert leads.docs["lead-1"]["status"] == "researching"


def test_pure_lock_rules():
    plan = LeadsRepo.plan_contacts_search_start
    assert plan(None, USER, NOW, False)["code"] == "lead_not_found"
    assert plan(make_lead(user=OTHER), USER, NOW, False)["code"] == "forbidden"
    assert plan(make_lead(), USER, NOW, False)["started"] is True
    running = make_lead(status="researching", search={"state": "running", "search_id": "s", "started_at": NOW})
    assert plan(running, USER, NOW, True)["code"] == "search_in_progress"
    later = NOW + timedelta(seconds=CONTACT_SEARCH_CONSIDERED_DEAD_AFTER_SECONDS)
    assert plan(running, USER, later, False) == {
        "started": True, "code": None, "next_search_allowed_at": None, "stale_search_id": "s",
    }
    assert LeadsRepo.can_finish_contacts_search(running, "s") is True
    assert LeadsRepo.can_finish_contacts_search(running, "other") is False
    assert LeadsRepo.can_finish_contacts_search(make_lead(search=found_search()), "old-search") is False


# ── Reuse by domain ───────────────────────────────────────────────────────────
def reuse_fixture(*, source_user=USER, days_ago=5.0, state="contacts_found", source_title=SUPPORT_TITLE,
                  source_contacts=None):
    area = vacancy_area(source_title)
    source = make_lead("lead-src", user=source_user, title=source_title, status="contacts_found",
                       search=found_search(days_ago=days_ago, area=area, state=state))
    target = make_lead("lead-new")
    if source_contacts is None:
        source_contacts = [
            stored("s-1", "lead-src", ANA, user=source_user, rank=1),
            stored("s-2", "lead-src", BRUNO, user=source_user, rank=2),
            stored("s-3", "lead-src", DIEGO, user=source_user, rank=3),
        ]
    return FakeLeads(source, target), FakeContacts(*source_contacts), target


async def test_reuse_copies_contacts_from_a_recent_search_without_calling_hunter():
    leads, contacts, target = reuse_fixture()
    provider = FakeProvider([CARLA])
    result = await make_service(leads, contacts, provider).research_lead(target, USER)

    assert provider.calls == []
    copied = contacts.of("lead-new")
    assert emails(copied) == {ANA.email, BRUNO.email, DIEGO.email}
    assert all(c["reused_from_lead_id"] == "lead-src" for c in copied)
    assert {c["reused_from_contact_id"] for c in copied} == {"s-1", "s-2", "s-3"}
    assert all(c["user_id"] == USER for c in copied)
    assert result["reused"] is True and result["reused_from_lead_id"] == "lead-src"
    assert result["credits_used"] == 0.0 and result["state"] == "contacts_found"
    search = leads.docs["lead-new"]["contacts_search"]
    assert search["query_type"] == "reuse" and search["reused_from_lead_id"] == "lead-src"
    assert len(contacts.of("lead-src")) == 3  # the source is untouched


async def test_reuse_works_without_a_hunter_key():
    leads, contacts, target = reuse_fixture()
    result = await make_service(leads, contacts, None, configured=False).research_lead(target, USER)
    assert result["reused"] is True and len(contacts.of("lead-new")) == 3


async def test_previous_search_older_than_the_reuse_window_searches_again():
    leads, contacts, target = reuse_fixture(days_ago=CONTACT_REUSE_MAX_AGE_DAYS + 1)
    provider = FakeProvider([CARLA])
    result = await make_service(leads, contacts, provider).research_lead(target, USER)
    assert len(provider.calls) == 1 and result["reused"] is False


async def test_previous_search_without_contacts_is_not_reused():
    leads, contacts, target = reuse_fixture(state="no_contacts", source_contacts=[])
    provider = FakeProvider([CARLA])
    result = await make_service(leads, contacts, provider).research_lead(target, USER)
    assert len(provider.calls) == 1 and result["reused"] is False


async def test_a_copy_is_never_used_as_a_reuse_source():
    leads, contacts, target = reuse_fixture()
    leads.docs["lead-src"]["contacts_search"]["reused_from_lead_id"] = "lead-older"
    provider = FakeProvider([CARLA])
    await make_service(leads, contacts, provider).research_lead(target, USER)
    assert len(provider.calls) == 1


async def test_another_area_requires_force():
    leads, contacts, target = reuse_fixture(source_title="Accounts Payable Clerk")
    assert vacancy_area("Accounts Payable Clerk") != vacancy_area(SUPPORT_TITLE)
    provider = FakeProvider([CARLA])
    service = make_service(leads, contacts, provider)

    with pytest.raises(ContactSearchRefused) as info:
        await service.research_lead(target, USER)
    assert info.value.code == "reuse_area_mismatch" and info.value.status_code == 409
    assert info.value.detail["reused_from_lead_id"] == "lead-src"
    assert provider.calls == [] and "contacts_search" not in leads.docs["lead-new"]

    result = await service.research_lead(target, USER, force=True)
    assert len(provider.calls) == 1 and result["reused"] is False


async def test_area_none_and_known_area_are_different():
    leads, contacts, _ = reuse_fixture()
    target = make_lead("lead-new", title="Zorblax Quux")
    assert vacancy_area("Zorblax Quux") is None
    leads.docs["lead-new"] = copy.deepcopy(target)
    with pytest.raises(ContactSearchRefused) as info:
        await make_service(leads, contacts, FakeProvider([])).research_lead(target, USER)
    assert info.value.code == "reuse_area_mismatch"


async def test_area_none_and_none_is_the_same_area():
    leads, contacts, _ = reuse_fixture(source_title="Zorblax Quux")
    target = make_lead("lead-new", title="Flimflam Wobble")
    assert vacancy_area("Flimflam Wobble") is None
    leads.docs["lead-new"] = copy.deepcopy(target)
    result = await make_service(leads, contacts, FakeProvider([])).research_lead(target, USER)
    assert result["reused"] is True


async def test_reuse_never_copies_another_users_contacts():
    leads, contacts, target = reuse_fixture(source_user=OTHER)
    provider = FakeProvider([CARLA])
    result = await make_service(leads, contacts, provider).research_lead(target, USER)

    assert result["reused"] is False and len(provider.calls) == 1
    copied = contacts.of("lead-new")
    assert emails(copied) == {CARLA.email}
    assert all(c["user_id"] == USER and c["reused_from_lead_id"] is None for c in copied)


def test_choose_reuse_source_filters_by_user_even_if_the_query_does_not():
    foreign = make_lead("lead-x", user=OTHER, search=found_search())
    mine = make_lead("lead-y", search=found_search(days_ago=3))
    area = vacancy_area(SUPPORT_TITLE)
    assert choose_reuse_source([foreign], "lead-new", USER, "example.com", area, NOW) == (None, None)
    kind, source = choose_reuse_source([foreign, mine], "lead-new", USER, "example.com", area, NOW)
    assert kind == "reuse" and source["id"] == "lead-y"


async def test_reuse_skips_contacts_rejected_on_the_source_or_on_the_target():
    leads, contacts, target = reuse_fixture(source_contacts=[
        stored("s-1", "lead-src", ANA, rank=1, review="rejected"),
        stored("s-2", "lead-src", BRUNO, rank=2),
        stored("s-3", "lead-src", DIEGO, rank=3),
    ])
    contacts.docs["t-1"] = stored("t-1", "lead-new", BRUNO, review="rejected")
    await make_service(leads, contacts, FakeProvider([])).research_lead(target, USER)

    new = contacts.of("lead-new")
    assert {c["email"] for c in new if c["review_status"] != "rejected"} == {DIEGO.email}
    assert contacts.docs["t-1"]["review_status"] == "rejected"


async def test_reused_address_with_an_old_verification_is_verified_again_within_the_cap():
    old = NOW - timedelta(days=200)
    leads, contacts, target = reuse_fixture(source_contacts=[
        stored("s-1", "lead-src", raw("Ana Ficticia", "Head of Customer Service", "ana.ficticia@example.com",
                                      verified_at=old), rank=1),
        stored("s-2", "lead-src", raw("Bruno Inventado", "Chief Executive Officer", "bruno.inventado@example.com",
                                      verified_at=old), rank=2),
    ])
    provider = FakeProvider(verify=lambda email: EmailVerification(status="valid", verified_at=NOW))
    result = await make_service(leads, contacts, provider).research_lead(target, USER)

    assert len(provider.verify_calls) == 1  # HUNTER_MAX_VERIFICATIONS_PER_LEAD
    assert provider.calls == []
    assert result["credits_used"] == 0.5
    refreshed = [c for c in contacts.of("lead-new") if c["email"] == provider.verify_calls[0]][0]
    assert refreshed["email_verification_source"] == "hunter_email_verifier"


async def test_reused_address_found_invalid_on_reverification_is_dropped():
    old = NOW - timedelta(days=200)
    leads, contacts, target = reuse_fixture(source_contacts=[
        stored("s-1", "lead-src", raw("Ana Ficticia", "Head of Customer Service", "ana.ficticia@example.com",
                                      verified_at=old), rank=1),
    ])
    provider = FakeProvider(verify=lambda email: EmailVerification(status="invalid", verified_at=NOW))
    result = await make_service(leads, contacts, provider).research_lead(target, USER)
    assert result["state"] == "no_contacts" and result["reason"] == "reused_contacts_unusable"
    assert provider.calls == []


async def test_recently_verified_reused_address_is_not_verified_again():
    leads, contacts, target = reuse_fixture(source_contacts=[
        stored("s-1", "lead-src", raw("Ana Ficticia", "Head of Customer Service", "ana.ficticia@example.com",
                                      verified_at=NOW - timedelta(days=10)), rank=1),
    ])
    provider = FakeProvider(verify=lambda email: EmailVerification(status="valid", verified_at=NOW))
    await make_service(leads, contacts, provider).research_lead(target, USER)
    assert provider.verify_calls == []


# ── Saving: no duplicates, review kept, rejected never offered ────────────────
async def test_repeating_the_search_updates_by_email_without_duplicates():
    lead = make_lead(status="contacts_found", search=found_search(days_ago=2))
    old_ana = raw("Ana Ficticia", "Head of Customer Service", "ANA.Ficticia@example.com", conf=0.6)
    contacts = FakeContacts(
        stored("c-ana", "lead-1", old_ana, rank=2),
        stored("c-old", "lead-1", raw("Fabio Antiguo", "VP of Operations", "fabio.antiguo@example.com"), rank=3),
        stored("c-kept", "lead-1", raw("Gina Aprobada", "VP of Finance", "gina.aprobada@example.com"),
               review="approved", rank=1),
    )
    leads = FakeLeads(lead)
    await make_service(leads, contacts, FakeProvider([ANA, BRUNO, DIEGO])).research_lead(lead, USER, force=True)

    saved = contacts.of("lead-1")
    assert len([c for c in saved if contact_key(c) == contact_key(ANA)]) == 1
    assert contacts.docs["c-ana"]["confidence_score"] == pytest.approx(0.9)
    assert "c-old" not in contacts.docs                       # unreviewed and out of the top: replaced
    assert contacts.docs["c-kept"]["review_status"] == "approved"
    assert contacts.docs["c-kept"]["rank"] is None            # kept, unranked
    assert len(saved) == 4


async def test_a_rejected_contact_is_not_offered_again():
    lead = make_lead(status="contacts_found", search=found_search(days_ago=2))
    contacts = FakeContacts(stored("c-ana", "lead-1", ANA, review="rejected", rank=1))
    before = copy.deepcopy(contacts.docs["c-ana"])
    result = await make_service(FakeLeads(lead), contacts, FakeProvider([ANA, BRUNO, CARLA, DIEGO])).research_lead(
        lead, USER, force=True,
    )

    assert ANA.email not in emails(result["contacts"])
    assert emails(result["contacts"]) == {BRUNO.email, CARLA.email, DIEGO.email}
    assert contacts.docs["c-ana"] == before
    assert len([c for c in contacts.of("lead-1") if contact_key(c) == contact_key(ANA)]) == 1


async def test_a_restored_contact_counts_again_in_searches_and_copies():
    lead = make_lead(status="contacts_found", search=found_search(days_ago=2))
    contacts = FakeContacts(stored("c-ana", "lead-1", ANA, review="rejected", rank=None))
    leads = FakeLeads(lead)
    service = make_service(leads, contacts, FakeProvider([ANA, BRUNO]))

    assert review_allowed("rejected", "approved")
    contacts.docs["c-ana"]["review_status"] = "approved"     # what PATCH .../review does
    result = await service.research_lead(lead, USER, force=True)
    assert ANA.email in emails(result["contacts"])
    assert contacts.docs["c-ana"]["review_status"] == "approved" and contacts.docs["c-ana"]["rank"] is not None

    # The restored contact is copied to a new lead of the same domain and area.
    target = make_lead("lead-new")
    leads.docs["lead-new"] = copy.deepcopy(target)
    reuse = await service.research_lead(target, USER)
    assert reuse["reused"] is True and ANA.email in emails(contacts.of("lead-new"))


async def test_an_existing_copy_does_not_change_when_the_source_contact_is_rejected_later():
    leads, contacts, target = reuse_fixture()
    service = make_service(leads, contacts, FakeProvider([]))
    await service.research_lead(target, USER)
    copy_of_ana = [c for c in contacts.of("lead-new") if c["email"] == ANA.email][0]
    contacts.docs["s-1"]["review_status"] = "rejected"
    assert contacts.docs[copy_of_ana["id"]]["review_status"] == copy_of_ana["review_status"]


# ── Small pure pieces ─────────────────────────────────────────────────────────
@pytest.mark.parametrize("current, decision, allowed", [
    ("not_required", "rejected", True), ("pending", "rejected", True), ("approved", "rejected", True),
    ("rejected", "rejected", False), ("pending", "approved", True), ("rejected", "approved", True),
    ("not_required", "approved", False), ("approved", "approved", False),
])
def test_review_transitions(current, decision, allowed):
    assert review_allowed(current, decision) is allowed


def test_sort_contacts_ranked_first_then_by_confidence():
    items = [{"id": "a", "rank": None, "confidence_score": 0.99}, {"id": "b", "rank": 2, "confidence_score": 0.1},
             {"id": "c", "rank": 1, "confidence_score": 0.2}, {"id": "d", "confidence_score": 0.5}]
    assert [c["id"] for c in sort_contacts(items)] == ["c", "b", "a", "d"]


async def test_select_contacts_reverifies_old_valid_addresses_only_with_the_cutoff():
    old = raw("Ana Ficticia", "Head of Customer Service", "ana.ficticia@example.com", verified_at=NOW - timedelta(days=200))
    calls = []

    class Verifier:
        async def verify_email(self, email):
            calls.append(email)
            return None

    context = LeadContext(job_title=SUPPORT_TITLE, company_name="Example Services", company_domain="example.com")
    await select_contacts([old], context, None, verifier=Verifier())
    assert calls == []
    await select_contacts([old], context, None, verifier=Verifier(), reverify_verified_before=NOW - timedelta(days=90))
    assert calls == [old.email]


def test_hunter_provider_reports_credits_spent_and_remaining():
    provider = HunterProvider("clave-sintetica")
    assert provider.credits_spent == 0.0 and provider.credits_remaining is None
    provider._credits = 10.0
    provider._spend(1.0)
    provider._spend(0.5)
    assert provider.credits_spent == 1.5 and provider.credits_remaining == 8.5
    assert "clave" not in repr(provider)


# ── Logs never carry personal data ────────────────────────────────────────────
async def test_logs_carry_no_names_nor_addresses(caplog):
    caplog.set_level(logging.DEBUG)
    leads, contacts, target = reuse_fixture()
    await make_service(leads, contacts, FakeProvider([])).research_lead(target, USER)
    lead = make_lead()
    leads.docs["lead-1"] = copy.deepcopy(lead)
    await make_service(leads, contacts, FakeProvider([ANA, BRUNO, CARLA, DRIVER])).research_lead(lead, USER, force=True)
    await make_service(leads, contacts, FakeProvider(exc=RuntimeError("Ana Ficticia ana.ficticia@example.com"))).research_lead(
        lead, USER, force=True,
    )

    text = caplog.text.lower()
    for secret in ("ficticia", "inventado", "sintetica", "ejemplo", "@example.com", "token-sintetico"):
        assert secret not in text


# ── LeadsRepo transactions (Firestore mocked) ─────────────────────────────────
def _repo_with_snapshot(doc: Optional[Dict[str, Any]]):
    snap = MagicMock(exists=doc is not None)
    snap.to_dict.return_value = copy.deepcopy(doc)
    ref = MagicMock()
    ref.get = AsyncMock(return_value=snap)
    db = MagicMock()
    db.collection.return_value.document.return_value = ref
    txn = MagicMock()
    db.transaction.return_value = txn
    return db, ref, txn


@pytest.fixture
def plain_transactional():
    with patch("app.services.firestore_service.firestore.async_transactional", side_effect=lambda fn: fn):
        yield


async def test_repo_try_start_writes_only_when_free(plain_transactional):
    db, ref, txn = _repo_with_snapshot(make_lead())
    with patch.object(LeadsRepo, "db", new_callable=PropertyMock, return_value=db):
        plan = await LeadsRepo().try_start_contacts_search("lead-1", USER, "s-1", False, NOW)
    assert plan["started"] is True
    txn.update.assert_called_once_with(ref, LeadsRepo.contacts_search_start_fields("s-1", NOW, False))

    running = make_lead(status="researching", search={"state": "running", "search_id": "s-0", "started_at": NOW})
    db, ref, txn = _repo_with_snapshot(running)
    with patch.object(LeadsRepo, "db", new_callable=PropertyMock, return_value=db):
        plan = await LeadsRepo().try_start_contacts_search("lead-1", USER, "s-1", True, NOW)
    assert plan["code"] == "search_in_progress"
    txn.update.assert_not_called()


async def test_repo_finish_writes_only_for_the_current_search(plain_transactional):
    running = make_lead(status="researching", search={"state": "running", "search_id": "s-1", "started_at": NOW})
    for search_id, writes in (("s-1", True), ("s-0", False)):
        db, ref, txn = _repo_with_snapshot(running)
        with patch.object(LeadsRepo, "db", new_callable=PropertyMock, return_value=db):
            wrote = await LeadsRepo().finish_contacts_search("lead-1", search_id, "new", {"state": "no_contacts"}, NOW)
        assert wrote is writes
        assert txn.update.called is writes


async def test_repo_domain_query_filters_by_user_and_nested_domain():
    with patch.object(LeadsRepo, "list", new_callable=AsyncMock, return_value=[]) as mock_list:
        await LeadsRepo().list_by_contacts_domain(USER, "example.com")
    filters = mock_list.call_args.kwargs["filters"]
    assert filters == [("user_id", "==", USER), ("contacts_search.domain", "==", "example.com")]


# ── lead.status after a contact review (RF15 fix) ─────────────────────────────
@pytest.mark.parametrize("current, has_active, expected", [
    ("contacts_found", False, "new"),
    ("contacts_found", True, None),          # already right: no write
    ("new", True, "contacts_found"),
    ("new", False, None),
    (None, True, "contacts_found"),          # a lead without status is new
    ("researching", False, None), ("composing", False, None), ("sent", True, None), ("error", True, None),
])
def test_plan_status_after_review(current, has_active, expected):
    lead = make_lead(status=current) if current else {**make_lead(), "status": None}
    assert LeadsRepo.plan_status_after_review(lead, USER, has_active) == expected


def test_plan_status_after_review_ignores_missing_or_foreign_leads():
    assert LeadsRepo.plan_status_after_review(None, USER, False) is None
    assert LeadsRepo.plan_status_after_review(make_lead(user=OTHER, status="contacts_found"), USER, False) is None


async def test_repo_recompute_writes_only_status_and_only_when_allowed(plain_transactional):
    lead = make_lead(status="contacts_found", search=found_search())
    db, ref, txn = _repo_with_snapshot(lead)
    with patch.object(LeadsRepo, "db", new_callable=PropertyMock, return_value=db):
        status = await LeadsRepo().recompute_status_after_review("lead-1", USER, False, NOW)
    assert status == "new"
    txn.update.assert_called_once_with(ref, {"status": "new", "updatedAt": NOW})  # never contacts_search

    for current, has_active in (("researching", False), ("contacts_found", True), ("sent", False)):
        db, ref, txn = _repo_with_snapshot(make_lead(status=current))
        with patch.object(LeadsRepo, "db", new_callable=PropertyMock, return_value=db):
            status = await LeadsRepo().recompute_status_after_review("lead-1", USER, has_active, NOW)
        assert status == current
        txn.update.assert_not_called()

    db, ref, txn = _repo_with_snapshot(make_lead(user=OTHER, status="contacts_found"))
    with patch.object(LeadsRepo, "db", new_callable=PropertyMock, return_value=db):
        await LeadsRepo().recompute_status_after_review("lead-1", USER, False, NOW)
    txn.update.assert_not_called()

    db, ref, txn = _repo_with_snapshot(None)
    with patch.object(LeadsRepo, "db", new_callable=PropertyMock, return_value=db):
        assert await LeadsRepo().recompute_status_after_review("lead-1", USER, False, NOW) is None
    txn.update.assert_not_called()
