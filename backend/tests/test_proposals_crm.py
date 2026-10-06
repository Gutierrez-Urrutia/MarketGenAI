"""Tests for POST /api/v1/proposals/{id}/send-to-crm (real HubSpot/Salesforce sync)."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services.crm_service import CrmAuthError, CrmProviderError, CrmTimeoutError
from tests.conftest import FAKE_USER_SUB
from tests.test_proposals import fake_proposal

API = "/api/v1/proposals"


def fake_settings(active="hubspot", connected=True) -> dict:
    """The exact connection payload doesn't matter — build_client_from_stored
    is mocked directly in these tests — only that a connection is present
    (or not) for the active/requested provider."""
    connections = {"hubspot": {"apiKeyEncrypted": "enc"}} if connected else {}
    return {"userId": FAKE_USER_SUB, "crm": {"activeProvider": active, "connections": connections}}


def fake_salesforce_settings(connected=True) -> dict:
    connections = {"salesforce": {
        "consumerKeyEncrypted": "enc-key", "consumerSecretEncrypted": "enc-secret", "loginUrl": "https://test.salesforce.com",
    }} if connected else {}
    return {"userId": FAKE_USER_SUB, "crm": {"activeProvider": "salesforce", "connections": connections}}


@pytest.mark.asyncio
async def test_send_to_crm_requires_client_email(client):
    proposal = fake_proposal({"clientEmail": None})
    with patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal):
        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})
    assert resp.status_code == 400
    assert "email" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_send_to_crm_requires_configured_connection(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_settings(connected=False)),
    ):
        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})
    assert resp.status_code == 400
    assert "crm" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_send_to_crm_no_active_provider_returns_400(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    settings_doc = {"userId": FAKE_USER_SUB, "crm": {"activeProvider": "none", "connections": {}}}
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=settings_doc),
    ):
        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})
    assert resp.status_code == 400
    assert "crm" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_send_to_crm_rejects_unsupported_provider(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    with patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal):
        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={"provider": "custom"})
    assert resp.status_code == 400
    assert "custom" in resp.json()["detail"].lower()


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
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build_client,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=updated) as update_proposal,
    ):
        hubspot = build_client.return_value
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
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build_client,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=proposal),
    ):
        hubspot = build_client.return_value
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
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build_client,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock) as update_proposal,
    ):
        hubspot = build_client.return_value
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
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build_client,
    ):
        hubspot = build_client.return_value
        hubspot.upsert_contact = AsyncMock(side_effect=CrmTimeoutError("Timeout al conectar con HubSpot"))

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})

    assert resp.status_code == 504


@pytest.mark.asyncio
async def test_send_to_crm_salesforce_requires_configured_credentials(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_salesforce_settings(connected=False)),
    ):
        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={"provider": "salesforce"})
    assert resp.status_code == 400
    assert "crm" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_send_to_crm_salesforce_success_creates_account_contact_and_opportunity(client):
    proposal = fake_proposal({
        "clientEmail": "client@example.com",
        "clientCompany": "Acme Corp",
        "totalAmount": 1500,
    })
    updated = {**proposal, "crmSync": {
        "provider": "salesforce", "status": "synced",
        "salesforceAccountId": "acc-1", "salesforceContactId": "contact-1", "salesforceOpportunityId": "opp-1",
    }}
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch(
            "app.routers.proposals.settings_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_salesforce_settings(),
        ),
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build_client,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=updated) as update_proposal,
    ):
        sf = build_client.return_value
        sf.upsert_account = AsyncMock(return_value="acc-1")
        sf.upsert_contact = AsyncMock(return_value="contact-1")
        sf.upsert_opportunity = AsyncMock(return_value="opp-1")

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={"provider": "salesforce"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["crmSync"]["status"] == "synced"
    assert body["crmSync"]["salesforceOpportunityId"] == "opp-1"

    sf.upsert_account.assert_awaited_once_with("Acme Corp")
    sf.upsert_contact.assert_awaited_once_with(email="client@example.com", name="Acme Corp", account_id="acc-1")
    sf.upsert_opportunity.assert_awaited_once_with(
        opportunity_id=None, name="Test Proposal", amount=1500, account_id="acc-1", contact_id="contact-1",
    )
    saved_crm_sync = update_proposal.await_args.args[1]["crmSync"]
    assert saved_crm_sync["status"] == "synced"


@pytest.mark.asyncio
async def test_send_to_crm_salesforce_reads_snake_case_total_amount(client):
    """Some proposal-saving flows on the frontend write `total_amount`
    (snake_case) instead of `totalAmount` — the CRM sync must still pick up
    the amount instead of silently sending $0."""
    proposal = fake_proposal({
        "clientEmail": "client@example.com",
        "clientCompany": "Acme Corp",
        "totalAmount": None,
        "total_amount": 5000,
    })
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch(
            "app.routers.proposals.settings_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_salesforce_settings(),
        ),
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build_client,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=proposal),
    ):
        sf = build_client.return_value
        sf.upsert_account = AsyncMock(return_value="acc-1")
        sf.upsert_contact = AsyncMock(return_value="contact-1")
        sf.upsert_opportunity = AsyncMock(return_value="opp-1")

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={"provider": "salesforce"})

    assert resp.status_code == 200
    sf.upsert_opportunity.assert_awaited_once_with(
        opportunity_id=None, name="Test Proposal", amount=5000, account_id="acc-1", contact_id="contact-1",
    )


@pytest.mark.asyncio
async def test_send_to_crm_salesforce_resend_updates_existing_opportunity(client):
    proposal = fake_proposal({
        "clientEmail": "client@example.com",
        "crmSync": {"provider": "salesforce", "status": "synced", "salesforceOpportunityId": "opp-99"},
    })
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch(
            "app.routers.proposals.settings_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_salesforce_settings(),
        ),
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build_client,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=proposal),
    ):
        sf = build_client.return_value
        sf.upsert_account = AsyncMock(return_value="acc-1")
        sf.upsert_contact = AsyncMock(return_value="contact-1")
        sf.upsert_opportunity = AsyncMock(return_value="opp-99")

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={"provider": "salesforce"})

    assert resp.status_code == 200
    sf.upsert_opportunity.assert_awaited_once_with(
        opportunity_id="opp-99", name="Test Proposal", amount=None, account_id="acc-1", contact_id="contact-1",
    )


@pytest.mark.asyncio
async def test_send_to_crm_without_explicit_provider_uses_active_provider(client):
    """The Proposals view has no access to the Settings page's React state,
    so it posts with no `provider` at all — the backend must fall back to
    whichever provider the user marked active in Settings -> Integrations."""
    proposal = fake_proposal({"clientEmail": "client@example.com", "clientCompany": "Acme Corp"})
    updated = {**proposal, "crmSync": {"provider": "salesforce", "status": "synced"}}
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch(
            "app.routers.proposals.settings_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_salesforce_settings(),
        ),
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build_client,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=updated),
    ):
        sf = build_client.return_value
        sf.upsert_account = AsyncMock(return_value="acc-1")
        sf.upsert_contact = AsyncMock(return_value="contact-1")
        sf.upsert_opportunity = AsyncMock(return_value="opp-1")

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})

    assert resp.status_code == 200
    assert resp.json()["crmSync"]["provider"] == "salesforce"
    build_client.assert_called_once_with("salesforce", fake_salesforce_settings()["crm"]["connections"])


@pytest.mark.asyncio
async def test_send_to_crm_salesforce_auth_error_returns_401(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch(
            "app.routers.proposals.settings_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_salesforce_settings(),
        ),
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build_client,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock) as update_proposal,
    ):
        sf = build_client.return_value
        sf.upsert_account = AsyncMock(side_effect=CrmAuthError("Consumer Key/Secret inválidos o sin permisos"))

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={"provider": "salesforce"})

    assert resp.status_code == 401
    update_proposal.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_to_crm_provider_error_marks_sync_failed(client):
    proposal = fake_proposal({"clientEmail": "client@example.com"})
    failed = {**proposal, "crmSync": {"provider": "hubspot", "status": "failed"}}
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_settings()),
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build_client,
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=failed) as update_proposal,
    ):
        hubspot = build_client.return_value
        hubspot.upsert_contact = AsyncMock(side_effect=CrmProviderError("HubSpot respondió con error 500"))

        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})

    assert resp.status_code == 502
    saved_crm_sync = update_proposal.await_args.args[1]["crmSync"]
    assert saved_crm_sync["status"] == "failed"
    assert "500" in saved_crm_sync["error"]
