"""Tests for POST /api/v1/proposals/{id}/send-to-crm (real HubSpot sync)."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services.crm_service import CrmAuthError, CrmProviderError, CrmTimeoutError
from tests.conftest import FAKE_USER_SUB
from tests.test_proposals import fake_proposal

API = "/api/v1/proposals"


def fake_settings(api_key: str | None = "hs-test-key") -> dict:
    return {"userId": FAKE_USER_SUB, "crm": {"provider": "hubspot", "apiKey": api_key}}


@pytest.mark.asyncio
async def test_send_to_crm_requires_client_email(client):
    proposal = fake_proposal({"clientEmail": None})
    with patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal):
        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})
    assert resp.status_code == 400
    assert "email" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_send_to_crm_requires_configured_api_key(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_settings(api_key=None)),
    ):
        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})
    assert resp.status_code == 400
    assert "crm" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_send_to_crm_rejects_unsupported_provider(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    with patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal):
        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={"provider": "salesforce"})
    assert resp.status_code == 400
    assert "salesforce" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_send_to_crm_success_creates_contact_and_deal(client):
    proposal = fake_proposal({
        "clientEmail": "client@example.com",
        "clientCompany": "Acme Corp",
        "totalAmount": 1500,
    })
    updated = {**proposal, "crmSync": {
        "provider": "hubspot", "status": "synced",
        "hubspotContactId": "contact-1", "hubspotDealId": "deal-1",
    }}
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_settings()),
        patch("app.routers.proposals.HubSpotClient") as hubspot_cls,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=updated) as update_proposal,
    ):
        hubspot = hubspot_cls.return_value
        hubspot.upsert_contact = AsyncMock(return_value="contact-1")
        hubspot.upsert_deal = AsyncMock(return_value="deal-1")

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})

    assert resp.status_code == 200
    body = resp.json()
    assert body["crmSync"]["status"] == "synced"
    assert body["crmSync"]["hubspotContactId"] == "contact-1"
    assert body["crmSync"]["hubspotDealId"] == "deal-1"

    hubspot.upsert_contact.assert_awaited_once_with(
        email="client@example.com", name="Acme Corp", company="Acme Corp",
    )
    hubspot.upsert_deal.assert_awaited_once_with(
        deal_id=None, dealname="Test Proposal", amount=1500, contact_id="contact-1",
    )
    saved_crm_sync = update_proposal.await_args.args[1]["crmSync"]
    assert saved_crm_sync["status"] == "synced"


@pytest.mark.asyncio
async def test_send_to_crm_resend_updates_existing_deal(client):
    proposal = fake_proposal({
        "clientEmail": "client@example.com",
        "crmSync": {"provider": "hubspot", "status": "synced", "hubspotDealId": "deal-99"},
    })
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_settings()),
        patch("app.routers.proposals.HubSpotClient") as hubspot_cls,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=proposal),
    ):
        hubspot = hubspot_cls.return_value
        hubspot.upsert_contact = AsyncMock(return_value="contact-1")
        hubspot.upsert_deal = AsyncMock(return_value="deal-99")

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})

    assert resp.status_code == 200
    hubspot.upsert_deal.assert_awaited_once_with(
        deal_id="deal-99", dealname="Test Proposal", amount=None, contact_id="contact-1",
    )


@pytest.mark.asyncio
async def test_send_to_crm_auth_error_returns_401(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_settings()),
        patch("app.routers.proposals.HubSpotClient") as hubspot_cls,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock) as update_proposal,
    ):
        hubspot = hubspot_cls.return_value
        hubspot.upsert_contact = AsyncMock(side_effect=CrmAuthError("API key inválida o sin permisos"))

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})

    assert resp.status_code == 401
    update_proposal.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_to_crm_timeout_returns_504(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_settings()),
        patch("app.routers.proposals.HubSpotClient") as hubspot_cls,
    ):
        hubspot = hubspot_cls.return_value
        hubspot.upsert_contact = AsyncMock(side_effect=CrmTimeoutError("Timeout al conectar con HubSpot"))

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})

    assert resp.status_code == 504


@pytest.mark.asyncio
async def test_send_to_crm_provider_error_marks_sync_failed(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    failed = {**proposal, "crmSync": {"provider": "hubspot", "status": "failed"}}
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_settings()),
        patch("app.routers.proposals.HubSpotClient") as hubspot_cls,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=failed) as update_proposal,
    ):
        hubspot = hubspot_cls.return_value
        hubspot.upsert_contact = AsyncMock(side_effect=CrmProviderError("HubSpot respondió con error 500"))

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})

    assert resp.status_code == 502
    saved_crm_sync = update_proposal.await_args.args[1]["crmSync"]
    assert saved_crm_sync["status"] == "failed"
    assert "500" in saved_crm_sync["error"]
