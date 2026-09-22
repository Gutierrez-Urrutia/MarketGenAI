"""Tests for the /api/v1/pipeline/config router (Fase 1 — infra only)."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from cryptography.fernet import Fernet

from app.services import encryption_service
from tests.conftest import FAKE_USER_SUB

API = "/api/v1/pipeline/config"


def fake_config(overrides: dict | None = None) -> dict:
    base = {
        "id": FAKE_USER_SUB,
        "userId": FAKE_USER_SUB,
        "keywords": ["BPO", "outsourcing"],
        "industries": ["finance"],
        "excluded_companies": [],
        "sources": [],
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 587,
        "smtp_user": "sales@noondalton.com",
        "sender_email": "sales@noondalton.com",
        "sender_name": "NoonDalton Sales",
        "auto_send_threshold": 0.8,
        "max_emails_per_day": 50,
        "scan_frequency_hours": 24,
        "is_active": True,
    }
    if overrides:
        base.update(overrides)
    return base


def fake_source(overrides: dict | None = None) -> dict:
    base = {
        "id": "source-001",
        "name": "Indeed RSS",
        "source_type": "rss",
        "enabled": True,
        "config": {"feed_url": "https://indeed.com/rss?q=outsourcing"},
        "rate_limit": None,
        "last_fetched_at": None,
    }
    if overrides:
        base.update(overrides)
    return base


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


# ── GET /pipeline/config ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_config_defaults_when_missing(client):
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=None,
    ):
        resp = await client.get(API)
    assert resp.status_code == 200
    body = resp.json()
    assert body["keywords"] == []
    assert body["smtp_password_configured"] is False
    assert "smtp_password" not in body
    assert "smtp_password_encrypted" not in body


@pytest.mark.asyncio
async def test_get_config_never_returns_encrypted_password(client):
    doc = fake_config({"smtp_password_encrypted": encryption_service.encrypt("s3cret")})
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=doc,
    ):
        resp = await client.get(API)
    assert resp.status_code == 200
    body = resp.json()
    assert body["smtp_password_configured"] is True
    assert "smtp_password" not in body
    assert "smtp_password_encrypted" not in body
    assert "s3cret" not in resp.text


# ── PUT /pipeline/config ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_update_config_encrypts_smtp_password(client):
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        mock_upsert.return_value = fake_config({
            "smtp_password_encrypted": encryption_service.encrypt("new-secret"),
        })
        resp = await client.put(API, json={"smtp_password": "new-secret"})

    assert resp.status_code == 200
    assert "new-secret" not in resp.text
    assert "smtp_password" not in resp.json()

    # The router must never persist the plaintext password.
    persisted_payload = mock_upsert.call_args.args[1]
    assert "smtp_password" not in persisted_payload
    assert persisted_payload["smtp_password_encrypted"] != "new-secret"
    assert encryption_service.decrypt(persisted_payload["smtp_password_encrypted"]) == "new-secret"


@pytest.mark.asyncio
async def test_update_config_strips_leading_trailing_whitespace(client):
    """Username (smtp_user), Sender Email and Sender Name must not persist
    accidental leading/trailing spaces."""
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        mock_upsert.return_value = fake_config()
        resp = await client.put(API, json={
            "smtp_user": "  sales@noondalton.com  ",
            "sender_email": "  sales@noondalton.com ",
            "sender_name": " NoonDalton Sales  ",
        })

    assert resp.status_code == 200
    persisted_payload = mock_upsert.call_args.args[1]
    assert persisted_payload["smtp_user"] == "sales@noondalton.com"
    assert persisted_payload["sender_email"] == "sales@noondalton.com"
    assert persisted_payload["sender_name"] == "NoonDalton Sales"


@pytest.mark.asyncio
async def test_update_config_rejects_invalid_sender_email(client):
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=fake_config(),
    ):
        resp = await client.put(API, json={"sender_email": "not-an-email"})

    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_update_config_whitespace_only_password_keeps_existing(client):
    """A Password field containing only spaces must be treated as if it were
    not provided at all — the previously saved password stays untouched."""
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        mock_upsert.return_value = fake_config()
        resp = await client.put(API, json={"smtp_password": "   "})

    assert resp.status_code == 200
    persisted_payload = mock_upsert.call_args.args[1]
    assert "smtp_password_encrypted" not in persisted_payload


@pytest.mark.asyncio
async def test_update_config_explicit_empty_password_clears_it(client):
    """An explicit empty string ("") is the one value that clears a
    previously configured password — distinct from whitespace-only above."""
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        mock_upsert.return_value = fake_config({"smtp_password_encrypted": ""})
        resp = await client.put(API, json={"smtp_password": ""})

    assert resp.status_code == 200
    persisted_payload = mock_upsert.call_args.args[1]
    assert persisted_payload["smtp_password_encrypted"] == ""


@pytest.mark.asyncio
async def test_update_config_password_not_stripped(client):
    """Unlike smtp_user/sender_email/sender_name, a real password's own
    leading/trailing spaces must be preserved — they can be intentional."""
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        mock_upsert.return_value = fake_config()
        resp = await client.put(API, json={"smtp_password": "  pad ded  "})

    assert resp.status_code == 200
    persisted_payload = mock_upsert.call_args.args[1]
    assert encryption_service.decrypt(persisted_payload["smtp_password_encrypted"]) == "  pad ded  "


@pytest.mark.asyncio
async def test_update_config_auto_send_threshold_persists_as_number(client):
    """auto_send_threshold must round-trip as a JSON number (float), never
    as a locale-formatted string, regardless of the client's locale."""
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        mock_upsert.return_value = fake_config({"auto_send_threshold": 0.8})
        resp = await client.put(API, json={"auto_send_threshold": 0.8})

    assert resp.status_code == 200
    persisted_payload = mock_upsert.call_args.args[1]
    assert persisted_payload["auto_send_threshold"] == 0.8
    assert isinstance(persisted_payload["auto_send_threshold"], float)
    assert isinstance(resp.json()["auto_send_threshold"], float)


@pytest.mark.asyncio
async def test_update_config_rejects_auto_send_threshold_as_string(client):
    """A stringified threshold (e.g. '0,8' from a mis-parsed locale input)
    must be rejected, not silently coerced or stored as text."""
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=fake_config(),
    ):
        resp = await client.put(API, json={"auto_send_threshold": "0,8"})

    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_update_config_returns_503_when_encryption_key_missing(client, monkeypatch):
    """PIPELINE_ENCRYPTION_KEY unset must surface as a clear 503 on this one
    endpoint, not crash the app or leak a raw stack trace."""
    monkeypatch.setattr(
        "app.services.encryption_service.settings.pipeline_encryption_key", ""
    )
    encryption_service._fernet.cache_clear()
    try:
        with patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ):
            resp = await client.put(API, json={"smtp_password": "new-secret"})
    finally:
        encryption_service._fernet.cache_clear()

    assert resp.status_code == 503
    assert "PIPELINE_ENCRYPTION_KEY" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_update_config_keywords_roundtrip(client):
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        mock_upsert.return_value = fake_config({"keywords": ["data entry"]})
        resp = await client.put(API, json={"keywords": ["data entry"]})

    assert resp.status_code == 200
    assert resp.json()["keywords"] == ["data entry"]


# ── Sources CRUD ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_source(client):
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        mock_upsert.return_value = fake_config({"sources": [fake_source()]})
        resp = await client.post(f"{API}/sources", json={
            "name": "Indeed RSS",
            "source_type": "rss",
            "config": {"feed_url": "https://indeed.com/rss?q=outsourcing"},
        })

    assert resp.status_code == 201
    assert len(resp.json()["sources"]) == 1


@pytest.mark.asyncio
async def test_delete_source_not_found(client):
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=fake_config({"sources": []}),
    ):
        resp = await client.delete(f"{API}/sources/does-not-exist")
    assert resp.status_code == 404


# ── /sources/{id}/test ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_test_source_rejects_missing_fields_for_rss(client):
    doc = fake_config({"sources": [fake_source({"config": {}})]})  # no feed_url
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=doc,
    ):
        resp = await client.post(f"{API}/sources/source-001/test")
    assert resp.status_code == 422
    assert "feed_url" in resp.json()["detail"]["missing_fields"]


@pytest.mark.asyncio
async def test_test_source_rejects_missing_fields_for_api(client):
    source = fake_source({
        "id": "source-002",
        "name": "JSearch",
        "source_type": "api",
        "config": {"base_url": "https://jsearch.p.rapidapi.com"},  # missing api_key
    })
    doc = fake_config({"sources": [source]})
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=doc,
    ):
        resp = await client.post(f"{API}/sources/source-002/test")
    assert resp.status_code == 422
    assert resp.json()["detail"]["missing_fields"] == ["api_key"]


@pytest.mark.asyncio
async def test_test_source_accepts_complete_config(client):
    source = fake_source({"config": {"feed_url": "https://indeed.com/rss?q=outsourcing"}})
    doc = fake_config({"sources": [source]})
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=doc,
    ):
        resp = await client.post(f"{API}/sources/source-001/test")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


# ── Encryption roundtrip ───────────────────────────────────────────────────────

def test_encryption_roundtrip():
    ciphertext = encryption_service.encrypt("s3cret-value")
    assert ciphertext != "s3cret-value"
    assert encryption_service.decrypt(ciphertext) == "s3cret-value"


def test_encryption_not_configured_raises(monkeypatch):
    monkeypatch.setattr(
        "app.services.encryption_service.settings.pipeline_encryption_key", ""
    )
    encryption_service._fernet.cache_clear()
    try:
        with pytest.raises(encryption_service.EncryptionNotConfiguredError):
            encryption_service.encrypt("anything")
    finally:
        encryption_service._fernet.cache_clear()


# ── Auth ───────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_config_requires_auth():
    from app.main import app as fastapi_app
    from httpx import AsyncClient, ASGITransport

    original_overrides = fastapi_app.dependency_overrides.copy()
    fastapi_app.dependency_overrides.clear()
    try:
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app),
            base_url="http://testserver",
        ) as ac:
            resp = await ac.get(API)
        assert resp.status_code in (401, 403)
    finally:
        fastapi_app.dependency_overrides.update(original_overrides)


@pytest.mark.asyncio
async def test_update_config_requires_auth():
    from app.main import app as fastapi_app
    from httpx import AsyncClient, ASGITransport

    original_overrides = fastapi_app.dependency_overrides.copy()
    fastapi_app.dependency_overrides.clear()
    try:
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app),
            base_url="http://testserver",
        ) as ac:
            resp = await ac.put(API, json={"keywords": ["x"]})
        assert resp.status_code in (401, 403)
    finally:
        fastapi_app.dependency_overrides.update(original_overrides)
