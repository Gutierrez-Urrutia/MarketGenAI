"""/api/v1/leads/{id}/contacts… (RF15, Fase 5): search, list and review.

Repositories are in-memory fakes or mocks; synthetic data only; no
network calls."""
from __future__ import annotations

import copy
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest

from app.core.pipeline_constants import CONTACT_SEARCH_RATE_LIMIT
from app.services.contact_research_service import ContactSearchRefused
from tests.conftest import FAKE_USER_SUB
from tests.test_contact_research_service import (
    ANA,
    BRUNO,
    CARLA,
    NOW,
    OTHER,
    FakeContacts,
    FakeLeads,
    FakeProvider,
    make_lead,
    make_service,
    stored,
)

API = "/api/v1/leads"
ROUTER = "app.routers.leads"


@pytest.fixture
def world():
    """A real service over fakes, wired into the router."""
    lead = make_lead()
    leads, contacts = FakeLeads(lead), FakeContacts()
    provider = FakeProvider([ANA, BRUNO, CARLA])
    service = make_service(leads, contacts, provider)
    with (
        patch(f"{ROUTER}.contact_research_service.get_service", return_value=service),
        patch(f"{ROUTER}.leads_repo.get_or_404", new=AsyncMock(side_effect=lambda lead_id: copy.deepcopy(
            leads.docs[lead_id]) if lead_id in leads.docs else (_ for _ in ()).throw(KeyError(lead_id)))),
        patch(f"{ROUTER}.contacts_repo.get", new=AsyncMock(side_effect=contacts.get)),
        patch(f"{ROUTER}.contacts_repo.update", new=AsyncMock(side_effect=contacts.update)),
    ):
        yield type("World", (), {"leads": leads, "contacts": contacts, "provider": provider, "service": service})


# ── POST /contacts/search ─────────────────────────────────────────────────────
async def test_search_returns_contacts_state_and_credits(client, world):
    resp = await client.post(f"{API}/lead-1/contacts/search")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "contacts_found" and body["lead_status"] == "contacts_found"
    assert [c["rank"] for c in body["contacts"]] == [1, 2, 3]
    assert body["credits_used"] == 1.0 and body["credits_remaining"] == 39.0
    assert body["reused"] is False and body["reused_from_lead_id"] is None
    assert body["next_search_allowed_at"] is not None
    assert {c["review_status"] for c in body["contacts"]} == {"not_required", "pending"}


async def test_search_force_flag_is_passed(client, world):
    await client.post(f"{API}/lead-1/contacts/search")
    resp = await client.post(f"{API}/lead-1/contacts/search")
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "cooldown"
    assert "next_search_allowed_at" in resp.json()["detail"]
    resp = await client.post(f"{API}/lead-1/contacts/search", json={"force": True})
    assert resp.status_code == 200 and len(world.provider.calls) == 2


async def test_search_of_another_users_lead_is_403(client, world):
    world.leads.docs["lead-1"]["user_id"] = OTHER
    resp = await client.post(f"{API}/lead-1/contacts/search")
    assert resp.status_code == 403
    assert world.provider.calls == []


async def test_search_of_a_missing_lead_is_404(client, world):
    resp = await client.post(f"{API}/nope/contacts/search")
    assert resp.status_code == 404


@pytest.mark.parametrize("code, http", [
    ("search_in_progress", 409), ("cooldown", 409), ("reuse_area_mismatch", 409), ("search_superseded", 409),
    ("lead_not_searchable", 422), ("hunter_not_configured", 422),
])
async def test_refusals_map_to_http_codes(client, world, code, http):
    refusing = AsyncMock(side_effect=ContactSearchRefused(code))
    with patch.object(world.service, "research_lead", refusing):
        resp = await client.post(f"{API}/lead-1/contacts/search")
    assert resp.status_code == http
    assert resp.json()["detail"]["code"] == code


async def test_provider_error_is_200_with_a_reason_code(client, world):
    from app.services.hunter_provider import HunterAuthError

    world.provider.exc = HunterAuthError()
    resp = await client.post(f"{API}/lead-1/contacts/search")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "error" and body["reason"] == "invalid_api_key" and body["contacts"] == []


async def test_search_is_rate_limited(client, world):
    limit = int(CONTACT_SEARCH_RATE_LIMIT.split("/")[0])
    refusing = AsyncMock(side_effect=ContactSearchRefused("cooldown"))
    with patch.object(world.service, "research_lead", refusing):
        codes = [(await client.post(f"{API}/lead-1/contacts/search")).status_code for _ in range(limit + 1)]
    assert codes[:limit] == [409] * limit and codes[-1] == 429


# ── GET /contacts ─────────────────────────────────────────────────────────────
async def test_list_contacts_sorted_and_without_rejected_by_default(client, world):
    world.contacts.docs.update({
        "c-1": stored("c-1", "lead-1", ANA, rank=2),
        "c-2": stored("c-2", "lead-1", BRUNO, rank=1),
        "c-3": stored("c-3", "lead-1", CARLA, review="rejected"),
        "c-4": stored("c-4", "lead-2", CARLA),
        "c-5": stored("c-5", "lead-1", CARLA, user=OTHER),
    })
    resp = await client.get(f"{API}/lead-1/contacts")
    assert resp.status_code == 200
    assert [c["id"] for c in resp.json()["items"]] == ["c-2", "c-1"]

    resp = await client.get(f"{API}/lead-1/contacts", params={"include_rejected": "true"})
    assert [c["id"] for c in resp.json()["items"]] == ["c-2", "c-1", "c-3"]


async def test_list_contacts_of_another_users_lead_is_403(client, world):
    world.leads.docs["lead-1"]["user_id"] = OTHER
    assert (await client.get(f"{API}/lead-1/contacts")).status_code == 403


async def test_contacts_saved_before_rf15_read_as_not_required(client, world):
    legacy = stored("c-1", "lead-1", ANA)
    for field in ("review_status", "rank", "search_id", "reused_from_lead_id", "reused_from_contact_id"):
        legacy.pop(field)
    world.contacts.docs["c-1"] = legacy
    resp = await client.get(f"{API}/lead-1/contacts")
    assert resp.json()["items"][0]["review_status"] == "not_required"


# ── PATCH /contacts/{id}/review ───────────────────────────────────────────────
@pytest.mark.parametrize("current, decision, http", [
    ("not_required", "rejected", 200), ("pending", "rejected", 200), ("approved", "rejected", 200),
    ("pending", "approved", 200), ("rejected", "approved", 200),
    ("not_required", "approved", 422), ("approved", "approved", 422), ("rejected", "rejected", 422),
])
async def test_review_transitions(client, world, current, decision, http):
    world.contacts.docs["c-1"] = stored("c-1", "lead-1", ANA, review=current)
    resp = await client.patch(f"{API}/lead-1/contacts/c-1/review", json={"decision": decision})
    assert resp.status_code == http
    if http == 200:
        assert resp.json()["review_status"] == decision
        assert world.contacts.docs["c-1"]["reviewed_at"] is not None
    else:
        assert resp.json()["detail"]["code"] == "invalid_review_transition"
        assert world.contacts.docs["c-1"]["review_status"] == current


async def test_restoring_a_rejection_makes_the_contact_count_again(client, world):
    world.contacts.docs["c-ana"] = stored("c-ana", "lead-1", ANA, review="rejected")
    first = await client.post(f"{API}/lead-1/contacts/search")
    assert ANA.email not in {c["email"] for c in first.json()["contacts"]}

    resp = await client.patch(f"{API}/lead-1/contacts/c-ana/review", json={"decision": "approved"})
    assert resp.status_code == 200
    again = await client.post(f"{API}/lead-1/contacts/search", json={"force": True})
    assert ANA.email in {c["email"] for c in again.json()["contacts"]}


async def test_review_of_a_contact_of_another_lead_or_user_is_404(client, world):
    world.contacts.docs["c-other-lead"] = stored("c-other-lead", "lead-2", ANA)
    world.contacts.docs["c-other-user"] = stored("c-other-user", "lead-1", ANA, user=OTHER)
    for contact_id in ("c-other-lead", "c-other-user", "missing"):
        resp = await client.patch(f"{API}/lead-1/contacts/{contact_id}/review", json={"decision": "rejected"})
        assert resp.status_code == 404
    assert world.contacts.docs["c-other-user"]["review_status"] == "not_required"


async def test_review_of_another_users_lead_is_403(client, world):
    world.leads.docs["lead-1"]["user_id"] = OTHER
    world.contacts.docs["c-1"] = stored("c-1", "lead-1", ANA, user=OTHER)
    resp = await client.patch(f"{API}/lead-1/contacts/c-1/review", json={"decision": "rejected"})
    assert resp.status_code == 403


async def test_review_rejects_an_unknown_decision(client, world):
    world.contacts.docs["c-1"] = stored("c-1", "lead-1", ANA, review="pending")
    resp = await client.patch(f"{API}/lead-1/contacts/c-1/review", json={"decision": "maybe"})
    assert resp.status_code == 422


async def test_lead_detail_exposes_contacts_search(client, world):
    await client.post(f"{API}/lead-1/contacts/search")
    resp = await client.get(f"{API}/lead-1")
    assert resp.status_code == 200
    assert resp.json()["contacts_search"]["state"] == "contacts_found"
    assert resp.json()["contacts_search"]["domain"] == "example.com"
