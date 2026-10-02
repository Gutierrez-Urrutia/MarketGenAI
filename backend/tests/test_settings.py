"""Tests for /api/v1/settings — CRM API key redaction and preservation."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import FAKE_USER_SUB

API = "/api/v1/settings"


def settings_doc(api_key: str | None = "hs-secret-key-1234") -> dict:
    return {
        "userId": FAKE_USER_SUB,
        "crm": {"provider": "hubspot", "apiKey": api_key},
        "llm": {},
        "socialConnections": [],
    }


@pytest.mark.asyncio
async def test_get_settings_redacts_crm_api_key(client):
    with patch("app.routers.settings.settings_repo.get_by_user", new_callable=AsyncMock, return_value=settings_doc()):
        resp = await client.get(API)
    assert resp.status_code == 200
    crm = resp.json()["crm"]
    assert crm["apiKey"] == "••••1234"
    assert crm["hasApiKey"] is True
    assert "hs-secret-key-1234" not in resp.text


@pytest.mark.asyncio
async def test_get_settings_without_crm_key_is_unchanged(client):
    doc = settings_doc(api_key=None)
    with patch("app.routers.settings.settings_repo.get_by_user", new_callable=AsyncMock, return_value=doc):
        resp = await client.get(API)
    assert resp.status_code == 200
    assert resp.json()["crm"]["apiKey"] is None


@pytest.mark.asyncio
async def test_update_settings_preserves_key_when_masked_value_roundtripped(client):
    existing = settings_doc()
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.put(API, json={"crm": {"provider": "hubspot", "apiKey": "••••1234"}})

    assert resp.status_code == 200
    saved_payload = update_settings.await_args.args[1]
    assert saved_payload["crm"]["apiKey"] == "hs-secret-key-1234"


@pytest.mark.asyncio
async def test_update_settings_without_api_key_preserves_existing_key(client):
    """Saving from an unrelated tab (e.g. Preferences -> handleSaveSettings,
    which only sends {provider}) must not wipe out a previously saved key —
    Firestore's update() otherwise replaces the whole `crm` map."""
    existing = settings_doc()
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.put(API, json={"crm": {"provider": "hubspot"}})

    assert resp.status_code == 200
    saved_payload = update_settings.await_args.args[1]
    assert saved_payload["crm"]["apiKey"] == "hs-secret-key-1234"


@pytest.mark.asyncio
async def test_update_settings_stores_new_key_when_changed(client):
    existing = settings_doc()
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.put(API, json={"crm": {"provider": "hubspot", "apiKey": "hs-brand-new-key"}})

    assert resp.status_code == 200
    saved_payload = update_settings.await_args.args[1]
    assert saved_payload["crm"]["apiKey"] == "hs-brand-new-key"


def salesforce_settings_doc() -> dict:
    return {
        "userId": FAKE_USER_SUB,
        "crm": {
            "provider": "salesforce",
            "salesforce": {
                "consumerKey": "3MVG9SecretConsumerKey1234",
                "consumerSecret": "sf-secret-5678",
                "loginUrl": "https://test.salesforce.com",
            },
        },
    }


@pytest.mark.asyncio
async def test_get_settings_redacts_salesforce_credentials(client):
    with patch(
        "app.routers.settings.settings_repo.get_by_user",
        new_callable=AsyncMock,
        return_value=salesforce_settings_doc(),
    ):
        resp = await client.get(API)
    assert resp.status_code == 200
    sf = resp.json()["crm"]["salesforce"]
    assert sf["consumerKey"] == "••••1234"
    assert sf["consumerSecret"] == "••••5678"
    assert sf["hasConsumerKey"] is True
    assert sf["hasConsumerSecret"] is True
    assert sf["loginUrl"] == "https://test.salesforce.com"
    assert "3MVG9SecretConsumerKey1234" not in resp.text
    assert "sf-secret-5678" not in resp.text


@pytest.mark.asyncio
async def test_update_settings_preserves_salesforce_secret_when_masked_roundtripped(client):
    existing = salesforce_settings_doc()
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.put(API, json={
            "crm": {
                "provider": "salesforce",
                "salesforce": {
                    "consumerKey": "••••1234",
                    "consumerSecret": "••••5678",
                    "loginUrl": "https://test.salesforce.com",
                },
            },
        })

    assert resp.status_code == 200
    saved_sf = update_settings.await_args.args[1]["crm"]["salesforce"]
    assert saved_sf["consumerKey"] == "3MVG9SecretConsumerKey1234"
    assert saved_sf["consumerSecret"] == "sf-secret-5678"


@pytest.mark.asyncio
async def test_update_settings_hubspot_only_save_preserves_salesforce_credentials(client):
    """Saving from a tab that only touches HubSpot fields must not wipe the
    separately-configured Salesforce sub-map, and vice versa."""
    existing = salesforce_settings_doc()
    with (
        patch("app.routers.settings.settings_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.settings.settings_repo.update", new_callable=AsyncMock, return_value=existing) as update_settings,
    ):
        resp = await client.put(API, json={"crm": {"provider": "hubspot"}})

    assert resp.status_code == 200
    saved_crm = update_settings.await_args.args[1]["crm"]
    assert saved_crm["salesforce"]["consumerSecret"] == "sf-secret-5678"


@pytest.mark.asyncio
async def test_crm_test_connection_salesforce_requires_all_fields(client):
    resp = await client.post(f"{API}/crm/test-connection", json={"provider": "salesforce", "consumerKey": "x"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_crm_test_connection_salesforce_success(client):
    with patch("app.routers.settings.SalesforceClient") as sf_cls:
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

    with patch("app.routers.settings.SalesforceClient") as sf_cls:
        sf_cls.return_value.test_connection = AsyncMock(side_effect=CrmAuthError("Consumer Key/Secret inválidos"))
        resp = await client.post(f"{API}/crm/test-connection", json={
            "provider": "salesforce",
            "consumerKey": "key",
            "consumerSecret": "bad-secret",
            "loginUrl": "https://test.salesforce.com",
        })
    assert resp.status_code == 401
