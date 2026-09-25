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
