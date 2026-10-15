"""Tests for /api/v1/settings — CRM connection storage, redaction, and the
active-provider selector."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from cryptography.fernet import Fernet

from app.services import encryption_service
from tests.conftest import FAKE_USER_SUB

API = "/api/v1/settings"


@pytest.fixture(autouse=True)
def _pipeline_encryption_key(monkeypatch):
    """Point pipeline_encryption_key at a real Fernet key for every test here."""
    key = Fernet.generate_key().decode()
    monkeypatch.setattr(
        "app.services.encryption_service.settings.pipeline_encryption_key", key
    )
    encryption_service._fernet.cache_clear()
    yield
    encryption_service._fernet.cache_clear()


def _hubspot_connection(api_key: str) -> dict:
    return {
        "apiKeyEncrypted": encryption_service.encrypt(api_key),
        "apiKeyLast4": api_key[-4:],
        "connectedAt": "2026-01-01T00:00:00+00:00",
    }


def _salesforce_connection(consumerKey: str, consumerSecret: str, loginUrl: str) -> dict:
    return {
        "consumerKeyEncrypted": encryption_service.encrypt(consumerKey),
        "consumerKeyLast4": consumerKey[-4:],
        "consumerSecretEncrypted": encryption_service.encrypt(consumerSecret),
        "consumerSecretLast4": consumerSecret[-4:],
        "loginUrl": loginUrl,
        "connectedAt": "2026-01-01T00:00:00+00:00",
    }


def crm_doc(active="none", hubspot=None, salesforce=None) -> dict:
    connections = {}
    if hubspot:
        connections["hubspot"] = _hubspot_connection(hubspot)
    if salesforce:
        connections["salesforce"] = _salesforce_connection(**salesforce)
    return {
        "userId": FAKE_USER_SUB,
        "crm": {"activeProvider": active, "connections": connections},
        "llm": {},
        "socialConnections": [],
    }


# ── GET /settings/crm/status ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_crm_status_redacts_hubspot_key(client):
    doc = crm_doc(active="hubspot", hubspot="hs-secret-key-1234")
    with patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=doc):
        resp = await client.get(f"{API}/crm/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["activeProvider"] == "hubspot"
    assert body["connections"]["hubspot"]["connected"] is True
    assert body["connections"]["hubspot"]["apiKeyLast4"] == "1234"
    assert "hs-secret-key-1234" not in resp.text


@pytest.mark.asyncio
async def test_crm_status_redacts_salesforce_credentials(client):
    doc = crm_doc(active="salesforce", salesforce={
        "consumerKey": "3MVG9SecretConsumerKey1234",
        "consumerSecret": "sf-secret-5678",
        "loginUrl": "https://test.salesforce.com",
    })
    with patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=doc):
        resp = await client.get(f"{API}/crm/status")
    assert resp.status_code == 200
    sf = resp.json()["connections"]["salesforce"]
    assert sf["connected"] is True
    assert sf["consumerKeyLast4"] == "1234"
    assert sf["consumerSecretLast4"] == "5678"
    assert sf["loginUrl"] == "https://test.salesforce.com"
    assert "3MVG9SecretConsumerKey1234" not in resp.text
    assert "sf-secret-5678" not in resp.text


@pytest.mark.asyncio
async def test_crm_status_defaults_to_disconnected(client):
    with patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.get(f"{API}/crm/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["activeProvider"] == "none"
    assert body["connections"]["hubspot"]["connected"] is False
    assert body["connections"]["salesforce"]["connected"] is False


@pytest.mark.asyncio
async def test_get_settings_includes_crm_status(client):
    doc = crm_doc(active="hubspot", hubspot="hs-secret-key-1234")
    with patch("app.routers.settings.settings_repo.get_by_user", new_callable=AsyncMock, return_value=doc):
        resp = await client.get(API)
    assert resp.status_code == 200
    crm = resp.json()["crm"]
    assert crm["activeProvider"] == "hubspot"
    assert crm["connections"]["hubspot"]["apiKeyLast4"] == "1234"
    assert "hs-secret-key-1234" not in resp.text


# ── POST /settings/crm/{provider}/connect ────────────────────────────────────

@pytest.mark.asyncio
async def test_connect_hubspot_stores_encrypted_key(client):
    existing = crm_doc()
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.post(f"{API}/crm/hubspot/connect", json={"apiKey": "hs-brand-new-key"})

    assert resp.status_code == 200
    assert resp.json()["connections"]["hubspot"]["connected"] is True
    saved_crm = update_settings.await_args.args[1]["crm"]
    stored = saved_crm["connections"]["hubspot"]
    assert stored["apiKeyLast4"] == "-key"
    assert encryption_service.decrypt(stored["apiKeyEncrypted"]) == "hs-brand-new-key"
    assert "hs-brand-new-key" not in resp.text


@pytest.mark.asyncio
async def test_connect_hubspot_requires_api_key(client):
    resp = await client.post(f"{API}/crm/hubspot/connect", json={"apiKey": ""})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_connect_hubspot_with_placeholder_keeps_existing_key(client):
    existing = crm_doc(active="hubspot", hubspot="hs-secret-key-1234")
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.post(f"{API}/crm/hubspot/connect", json={"apiKey": "••••1234"})

    assert resp.status_code == 200
    saved_crm = update_settings.await_args.args[1]["crm"]
    stored = saved_crm["connections"]["hubspot"]
    assert encryption_service.decrypt(stored["apiKeyEncrypted"]) == "hs-secret-key-1234"


@pytest.mark.asyncio
async def test_connect_salesforce_requires_all_fields(client):
    resp = await client.post(f"{API}/crm/salesforce/connect", json={"consumerKey": "x"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_connect_salesforce_stores_encrypted_credentials(client):
    existing = crm_doc()
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.post(f"{API}/crm/salesforce/connect", json={
            "consumerKey": "3MVG9SecretConsumerKey1234",
            "consumerSecret": "sf-secret-5678",
            "loginUrl": "https://test.salesforce.com",
        })

    assert resp.status_code == 200
    saved_crm = update_settings.await_args.args[1]["crm"]
    stored = saved_crm["connections"]["salesforce"]
    assert encryption_service.decrypt(stored["consumerKeyEncrypted"]) == "3MVG9SecretConsumerKey1234"
    assert encryption_service.decrypt(stored["consumerSecretEncrypted"]) == "sf-secret-5678"
    assert stored["loginUrl"] == "https://test.salesforce.com"


@pytest.mark.asyncio
async def test_connect_salesforce_with_placeholder_secret_keeps_existing_secret_but_updates_key(client):
    """Changing just the Consumer Key (leaving the masked secret untouched)
    must not wipe the previously-stored secret."""
    existing = crm_doc(active="salesforce", salesforce={
        "consumerKey": "old-consumer-key",
        "consumerSecret": "sf-secret-5678",
        "loginUrl": "https://test.salesforce.com",
    })
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.post(f"{API}/crm/salesforce/connect", json={
            "consumerKey": "new-consumer-key",
            "consumerSecret": "••••5678",
            "loginUrl": "https://test.salesforce.com",
        })

    assert resp.status_code == 200
    stored = update_settings.await_args.args[1]["crm"]["connections"]["salesforce"]
    assert encryption_service.decrypt(stored["consumerKeyEncrypted"]) == "new-consumer-key"
    assert encryption_service.decrypt(stored["consumerSecretEncrypted"]) == "sf-secret-5678"


@pytest.mark.asyncio
async def test_connect_hubspot_does_not_touch_salesforce_connection(client):
    existing = crm_doc(active="salesforce", salesforce={
        "consumerKey": "sf-key", "consumerSecret": "sf-secret", "loginUrl": "https://test.salesforce.com",
    })
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.post(f"{API}/crm/hubspot/connect", json={"apiKey": "hs-new-key"})

    assert resp.status_code == 200
    saved_crm = update_settings.await_args.args[1]["crm"]
    assert "salesforce" in saved_crm["connections"]
    assert encryption_service.decrypt(saved_crm["connections"]["salesforce"]["consumerSecretEncrypted"]) == "sf-secret"


@pytest.mark.asyncio
async def test_connect_unsupported_provider_returns_400(client):
    resp = await client.post(f"{API}/crm/pipedrive/connect", json={"apiKey": "x"})
    assert resp.status_code == 400


# ── DELETE /settings/crm/{provider} ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_disconnect_provider_removes_connection_and_resets_active(client):
    existing = crm_doc(active="hubspot", hubspot="hs-secret-key-1234")
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.delete(f"{API}/crm/hubspot")

    assert resp.status_code == 200
    saved_crm = update_settings.await_args.args[1]["crm"]
    assert "hubspot" not in saved_crm["connections"]
    assert saved_crm["activeProvider"] == "none"
    assert resp.json()["activeProvider"] == "none"


@pytest.mark.asyncio
async def test_disconnect_inactive_provider_keeps_active_provider(client):
    existing = crm_doc(active="salesforce", hubspot="hs-secret-key-1234", salesforce={
        "consumerKey": "sf-key", "consumerSecret": "sf-secret", "loginUrl": "https://test.salesforce.com",
    })
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.delete(f"{API}/crm/hubspot")

    assert resp.status_code == 200
    saved_crm = update_settings.await_args.args[1]["crm"]
    assert saved_crm["activeProvider"] == "salesforce"


# ── PUT /settings/crm/active-provider ────────────────────────────────────────

@pytest.mark.asyncio
async def test_set_active_provider_requires_existing_connection(client):
    existing = crm_doc()
    with patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing):
        resp = await client.put(f"{API}/crm/active-provider", json={"activeProvider": "hubspot"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_set_active_provider_succeeds_when_connected(client):
    existing = crm_doc(hubspot="hs-secret-key-1234")
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.put(f"{API}/crm/active-provider", json={"activeProvider": "hubspot"})
    assert resp.status_code == 200
    assert resp.json()["activeProvider"] == "hubspot"
    assert update_settings.await_args.args[1]["crm"]["activeProvider"] == "hubspot"


@pytest.mark.asyncio
async def test_set_active_provider_none_always_allowed(client):
    existing = crm_doc(active="hubspot", hubspot="hs-secret-key-1234")
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing),
    ):
        resp = await client.put(f"{API}/crm/active-provider", json={"activeProvider": "none"})
    assert resp.status_code == 200
    assert resp.json()["activeProvider"] == "none"


# ── POST /settings/crm/test-connection ───────────────────────────────────────

@pytest.mark.asyncio
async def test_crm_test_connection_hubspot_requires_api_key(client):
    with patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.post(f"{API}/crm/test-connection", json={"provider": "hubspot", "apiKey": ""})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_crm_test_connection_hubspot_resolves_placeholder_against_stored_key(client):
    existing = crm_doc(active="hubspot", hubspot="hs-secret-key-1234")
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.HubSpotClient") as hubspot_cls,
    ):
        hubspot_cls.return_value.test_connection = AsyncMock(
            return_value={"status": "connected", "message": "Conexión exitosa con HubSpot"}
        )
        resp = await client.post(f"{API}/crm/test-connection", json={"provider": "hubspot", "apiKey": "••••1234"})
    assert resp.status_code == 200
    hubspot_cls.assert_called_once_with("hs-secret-key-1234")


@pytest.mark.asyncio
async def test_crm_test_connection_salesforce_requires_all_fields(client):
    with patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.post(f"{API}/crm/test-connection", json={"provider": "salesforce", "consumerKey": "x"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_crm_test_connection_salesforce_success(client):
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=None),
        patch("app.routers.settings.SalesforceClient") as sf_cls,
    ):
        sf_cls.return_value.test_connection = AsyncMock(
            return_value={"status": "connected", "message": "Conexión exitosa con Salesforce"}
        )
        resp = await client.post(f"{API}/crm/test-connection", json={
            "provider": "salesforce",
            "consumerKey": "key",
            "consumerSecret": "secret",
            "loginUrl": "https://test.salesforce.com",
        })
    assert resp.status_code == 200
    assert resp.json()["status"] == "connected"
    sf_cls.assert_called_once_with("key", "secret", "https://test.salesforce.com")


@pytest.mark.asyncio
async def test_crm_test_connection_salesforce_auth_error(client):
    from app.services.crm_service import CrmAuthError

    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=None),
        patch("app.routers.settings.SalesforceClient") as sf_cls,
    ):
        sf_cls.return_value.test_connection = AsyncMock(side_effect=CrmAuthError("Consumer Key/Secret inválidos"))
        resp = await client.post(f"{API}/crm/test-connection", json={
            "provider": "salesforce",
            "consumerKey": "key",
            "consumerSecret": "bad-secret",
            "loginUrl": "https://test.salesforce.com",
        })
    assert resp.status_code == 401


async def test_connect_hubspot_without_encryption_key_returns_503(client, monkeypatch):
    monkeypatch.setattr("app.services.encryption_service.settings.pipeline_encryption_key", "")
    encryption_service._fernet.cache_clear()
    with patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.post(f"{API}/crm/hubspot/connect", json={"apiKey": "hs-brand-new-key"})
    assert resp.status_code == 503
    assert "PIPELINE_ENCRYPTION_KEY" in resp.json()["detail"]
