"""Tests for the /api/v1/pipeline/config router (Fase 1 — infra only)."""
from __future__ import annotations

import socket
from unittest.mock import AsyncMock, patch

import pytest
from cryptography.fernet import Fernet

from app.core import url_safety
from app.services import encryption_service
from tests.conftest import FAKE_USER_SUB

API = "/api/v1/pipeline/config"


@pytest.fixture(autouse=True)
def _fake_dns_resolves_to_public_ip():
    """create_source/update_source now validate a source's URL (SSRF check,
    app.core.url_safety) on save. Most tests here use real-looking but
    arbitrary domains and shouldn't depend on real DNS/network access —
    resolve everything to a public IP by default. The one test that
    exercises the actual rejection overrides this within its own block."""
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo):
        yield


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
async def test_create_source_rejects_url_resolving_to_internal_address(client):
    """A source whose URL resolves to a private/loopback/link-local address
    (e.g. cloud metadata) must be rejected immediately on save, before it's
    ever persisted or scanned."""
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 0))]

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        resp = await client.post(f"{API}/sources", json={
            "name": "Suspicious RSS",
            "source_type": "rss",
            "config": {"feed_url": "https://internal.example.com/rss"},
        })

    assert resp.status_code == 422
    assert "Unsafe source URL" in resp.json()["detail"]
    mock_upsert.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("title_format", ["none", "company_colon_title", "title_dash_company"])
async def test_create_source_accepts_valid_title_format(client, title_format):
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
            "name": "WWR",
            "source_type": "rss",
            "config": {"feed_url": "https://weworkremotely.com/x.rss", "title_format": title_format},
        })

    assert resp.status_code == 201
    saved = mock_upsert.call_args.args[1]["sources"][-1]
    assert saved["config"]["title_format"] == title_format


@pytest.mark.asyncio
@pytest.mark.parametrize("source_type, config, detail", [
    ("rss", {"feed_url": "https://weworkremotely.com/x.rss", "title_format": "guess"}, "Invalid title_format"),
    ("api", {"base_url": "https://api.example.com", "title_format": "company_colon_title"}, "only applies to RSS"),
])
async def test_create_source_rejects_bad_title_format(client, source_type, config, detail):
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
        resp = await client.post(f"{API}/sources", json={
            "name": "Bad", "source_type": source_type, "config": config,
        })

    assert resp.status_code == 422
    assert detail in resp.json()["detail"]
    mock_upsert.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_source_rejects_invalid_title_format(client):
    doc = fake_config({"sources": [fake_source()]})
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=doc,
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        resp = await client.put(f"{API}/sources/source-001", json={
            "config": {"feed_url": "https://indeed.com/rss?q=outsourcing", "title_format": "guess"},
        })

    assert resp.status_code == 422
    mock_upsert.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_source_rejects_url_resolving_to_internal_address(client):
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]

    doc = fake_config({"sources": [fake_source()]})
    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=doc,
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        resp = await client.put(f"{API}/sources/source-001", json={
            "config": {"feed_url": "https://internal.example.com/rss"},
        })

    assert resp.status_code == 422
    assert "Unsafe source URL" in resp.json()["detail"]
    mock_upsert.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_source_encrypts_api_key(client):
    """A source's secret config fields (api_key for source_type=api) must be
    encrypted before persisting and never returned in plaintext."""
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
        mock_upsert.return_value = fake_config({"sources": [fake_source({
            "source_type": "api",
            "config": {"base_url": "https://jsearch.p.rapidapi.com"},
            "config_encrypted": {"api_key": encryption_service.encrypt("rapid-key-123")},
        })]})
        resp = await client.post(f"{API}/sources", json={
            "name": "JSearch",
            "source_type": "api",
            "config": {"base_url": "https://jsearch.p.rapidapi.com", "api_key": "rapid-key-123"},
        })

    assert resp.status_code == 201
    assert "rapid-key-123" not in resp.text

    persisted_sources = mock_upsert.call_args.args[1]["sources"]
    persisted_source = persisted_sources[0]
    assert "api_key" not in persisted_source["config"]
    assert persisted_source["config"]["base_url"] == "https://jsearch.p.rapidapi.com"
    assert encryption_service.decrypt(persisted_source["config_encrypted"]["api_key"]) == "rapid-key-123"

    body_source = resp.json()["sources"][0]
    assert "config_encrypted" not in body_source
    assert "api_key" not in body_source["config"]
    assert body_source["configured_secret_fields"] == ["api_key"]


@pytest.mark.asyncio
async def test_get_config_never_returns_source_api_key(client):
    doc = fake_config({"sources": [fake_source({
        "source_type": "api",
        "config": {"base_url": "https://jsearch.p.rapidapi.com"},
        "config_encrypted": {"api_key": encryption_service.encrypt("rapid-key-123")},
    })]})
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=doc,
    ):
        resp = await client.get(API)

    assert resp.status_code == 200
    assert "rapid-key-123" not in resp.text
    source = resp.json()["sources"][0]
    assert source["configured_secret_fields"] == ["api_key"]


@pytest.mark.asyncio
async def test_update_source_re_encrypts_new_api_key(client):
    existing_source = fake_source({
        "source_type": "api",
        "config": {"base_url": "https://jsearch.p.rapidapi.com"},
        "config_encrypted": {"api_key": encryption_service.encrypt("old-key")},
    })
    doc = fake_config({"sources": [existing_source]})
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=doc,
        ),
        patch(
            "app.routers.pipeline.pipeline_configs_repo.upsert_for_user",
            new_callable=AsyncMock,
        ) as mock_upsert,
    ):
        mock_upsert.return_value = doc
        resp = await client.put(f"{API}/sources/source-001", json={
            "config": {"base_url": "https://jsearch.p.rapidapi.com", "api_key": "new-key"},
        })

    assert resp.status_code == 200
    persisted_sources = mock_upsert.call_args.args[1]["sources"]
    persisted_source = persisted_sources[0]
    assert encryption_service.decrypt(persisted_source["config_encrypted"]["api_key"]) == "new-key"


async def _put_source(client, source: dict, body: dict) -> dict:
    doc = fake_config({"sources": [source]})
    with (
        patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock, return_value=doc),
        patch("app.routers.pipeline.pipeline_configs_repo.upsert_for_user", new_callable=AsyncMock) as mock_upsert,
    ):
        mock_upsert.return_value = doc
        resp = await client.put(f"{API}/sources/source-001", json=body)
    assert resp.status_code == 200
    return mock_upsert.call_args.args[1]["sources"][0]


# RF13-D-004: editar una fuente sin volver a escribir la clave no debe borrarla. La pantalla nunca
# recibe la clave, así que envía la config pública (sin api_key) o el campo vacío.
@pytest.mark.asyncio
@pytest.mark.parametrize("config", [
    {"base_url": "https://jsearch.p.rapidapi.com"},
    {"base_url": "https://jsearch.p.rapidapi.com", "api_key": ""},
])
async def test_update_source_keeps_stored_api_key_when_not_resent(client, config):
    source = fake_source({
        "source_type": "api",
        "config": {"base_url": "https://jsearch.p.rapidapi.com"},
        "config_encrypted": {"api_key": encryption_service.encrypt("stored-key")},
    })
    persisted = await _put_source(client, source, {"name": "JSearch renombrada", "config": config})
    assert persisted["name"] == "JSearch renombrada"
    assert encryption_service.decrypt(persisted["config_encrypted"]["api_key"]) == "stored-key"


@pytest.mark.asyncio
async def test_update_source_encrypts_legacy_plaintext_api_key_on_edit(client):
    """A legacy source (api_key still in plaintext config) keeps its key when
    edited from the screen, and it gets encrypted on that save."""
    source = fake_source({
        "source_type": "api",
        "config": {"base_url": "https://jsearch.p.rapidapi.com", "api_key": "legacy-key"},
        "config_encrypted": {},
    })
    persisted = await _put_source(client, source, {"config": {"base_url": "https://jsearch.p.rapidapi.com"}})
    assert "api_key" not in persisted["config"]
    assert encryption_service.decrypt(persisted["config_encrypted"]["api_key"]) == "legacy-key"


@pytest.mark.asyncio
async def test_create_source_returns_503_when_encryption_key_missing(client, monkeypatch):
    monkeypatch.setattr(
        "app.services.encryption_service.settings.pipeline_encryption_key", ""
    )
    encryption_service._fernet.cache_clear()
    try:
        with patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=fake_config(),
        ):
            resp = await client.post(f"{API}/sources", json={
                "name": "JSearch",
                "source_type": "api",
                "config": {"base_url": "https://jsearch.p.rapidapi.com", "api_key": "rapid-key-123"},
            })
    finally:
        encryption_service._fernet.cache_clear()

    assert resp.status_code == 503
    assert "PIPELINE_ENCRYPTION_KEY" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_test_source_accepts_api_key_only_in_encrypted_config(client):
    """A source whose api_key already lives in config_encrypted (from a
    previous save) must still pass the required-fields check."""
    source = fake_source({
        "id": "source-002",
        "name": "JSearch",
        "source_type": "api",
        "config": {"base_url": "https://jsearch.p.rapidapi.com"},
        "config_encrypted": {"api_key": encryption_service.encrypt("rapid-key-123")},
    })
    doc = fake_config({"sources": [source]})
    with (
        patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock, return_value=doc),
        patch("app.routers.pipeline.job_scout_service._scan_source", new_callable=AsyncMock, return_value=[]),
    ):
        resp = await client.post(f"{API}/sources/source-002/test")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


@pytest.mark.asyncio
async def test_get_config_never_returns_legacy_plaintext_api_key(client):
    """A source created before commit 92a01c4 (the fix that started
    encrypting api_key) may still have it sitting in plaintext `config` —
    that must not leak through GET /pipeline/config either."""
    doc = fake_config({"sources": [fake_source({
        "source_type": "api",
        "config": {"base_url": "https://jsearch.p.rapidapi.com", "api_key": "legacy-plaintext-key"},
        "config_encrypted": {},
    })]})
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=doc,
    ):
        resp = await client.get(API)

    assert resp.status_code == 200
    assert "legacy-plaintext-key" not in resp.text
    source = resp.json()["sources"][0]
    assert "api_key" not in source["config"]
    assert source["configured_secret_fields"] == ["api_key"]


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
    with (
        patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock, return_value=doc),
        patch("app.routers.pipeline.job_scout_service._scan_source", new_callable=AsyncMock, return_value=[]),
    ):
        resp = await client.post(f"{API}/sources/source-001/test")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


# RF13-D-001: «Probar conexión» lee la fuente de verdad (mismo adaptador del escaneo), sin red real aquí.
RSS_DOS_AVISOS = (b'<?xml version="1.0"?><rss version="2.0"><channel><title>QA</title>'
                  b'<item><title>Acme: Analista</title><link>https://x.example.com/1</link></item>'
                  b'<item><title>Beta: Agente</title><link>https://x.example.com/2</link></item></channel></rss>')


async def _probar_fuente(client, status_code: int, content: bytes) -> dict:
    import httpx
    from app.services import job_scout_service

    class _Ctx:
        async def __aenter__(self):
            return httpx.Response(status_code, content=content, request=httpx.Request("GET", "https://qa.example.com/feed"))

        async def __aexit__(self, *exc):
            return False

    doc = fake_config({"sources": [fake_source({"config": {"feed_url": "https://qa.example.com/feed"}})]})
    with (
        patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock, return_value=doc),
        patch.object(httpx.AsyncClient, "stream", lambda self, *a, **k: _Ctx()),
        patch.object(job_scout_service, "score_relevance_batch", new_callable=AsyncMock) as mock_score,
    ):
        resp = await client.post(f"{API}/sources/source-001/test")
    mock_score.assert_not_called()  # probar una fuente nunca llama al modelo
    assert resp.status_code == 200
    return resp.json()


@pytest.mark.asyncio
async def test_test_source_reports_a_source_that_does_not_respond(client):
    body = await _probar_fuente(client, 404, b"not found")
    assert body["ok"] is False
    assert "HTTP 404" in body["reason"]


@pytest.mark.asyncio
async def test_test_source_reads_the_postings_of_a_working_source(client):
    body = await _probar_fuente(client, 200, RSS_DOS_AVISOS)
    assert body["ok"] is True
    assert body["postings_read"] == 2


# ── JSearch sources ────────────────────────────────────────────────────────────

JSEARCH_KEY = "rapid-jsearch-key-456"


def _jsearch_source(config: dict | None = None, **overrides) -> dict:
    return fake_source({
        "id": "source-js",
        "name": "JSearch",
        "source_type": "jsearch",
        "config": config if config is not None else {},
        "config_encrypted": {"api_key": encryption_service.encrypt(JSEARCH_KEY)},
        **overrides,
    })


@pytest.mark.asyncio
async def test_create_jsearch_source_encrypts_api_key_and_never_returns_it(client):
    with (
        patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock, return_value=fake_config()),
        patch("app.routers.pipeline.pipeline_configs_repo.upsert_for_user", new_callable=AsyncMock) as mock_upsert,
    ):
        mock_upsert.side_effect = lambda user_id, payload: fake_config(payload)
        resp = await client.post(f"{API}/sources", json={
            "name": "JSearch",
            "source_type": "jsearch",
            "config": {"api_key": JSEARCH_KEY, "country": "gb", "language": "en", "num_pages": 2},
        })

    assert resp.status_code == 201
    persisted = mock_upsert.call_args.args[1]["sources"][0]
    assert persisted["source_type"] == "jsearch"
    assert persisted["config"] == {"country": "gb", "language": "en", "num_pages": 2}
    encrypted_token = persisted["config_encrypted"]["api_key"]
    assert encryption_service.decrypt(encrypted_token) == JSEARCH_KEY

    assert JSEARCH_KEY not in resp.text
    assert encrypted_token not in resp.text
    body_source = resp.json()["sources"][0]
    assert "config_encrypted" not in body_source
    assert body_source["configured_secret_fields"] == ["api_key"]

    with patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock,
               return_value=fake_config({"sources": [persisted]})):
        get_resp = await client.get(API)
    assert get_resp.status_code == 200
    assert JSEARCH_KEY not in get_resp.text
    assert encrypted_token not in get_resp.text


@pytest.mark.asyncio
async def test_update_jsearch_source_keeps_stored_api_key(client):
    source = _jsearch_source({"num_pages": 1})
    stored_token = source["config_encrypted"]["api_key"]
    with (
        patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock,
              return_value=fake_config({"sources": [source]})),
        patch("app.routers.pipeline.pipeline_configs_repo.upsert_for_user", new_callable=AsyncMock) as mock_upsert,
    ):
        mock_upsert.side_effect = lambda user_id, payload: fake_config(payload)
        resp = await client.put(f"{API}/sources/source-js", json={"config": {"num_pages": 3}})

    assert resp.status_code == 200
    persisted = mock_upsert.call_args.args[1]["sources"][0]
    assert persisted["config_encrypted"]["api_key"] == stored_token
    assert JSEARCH_KEY not in resp.text and stored_token not in resp.text


@pytest.mark.asyncio
@pytest.mark.parametrize("config, detail_fragment", [
    ({"num_pages": 4}, "num_pages"),
    ({"num_pages": 0}, "num_pages"),
    ({"num_pages": "2"}, "num_pages"),
    ({"date_posted": "yesterday"}, "date_posted"),
    ({"country": "GBR"}, "country"),
    ({"country": "g1"}, "country"),
    ({"country": ""}, "country"),
    ({"language": "english"}, "language"),
    ({"language": 12}, "language"),
])
async def test_create_jsearch_source_rejects_invalid_config(client, config, detail_fragment):
    with (
        patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock, return_value=fake_config()),
        patch("app.routers.pipeline.pipeline_configs_repo.upsert_for_user", new_callable=AsyncMock) as mock_upsert,
    ):
        resp = await client.post(f"{API}/sources", json={
            "name": "JSearch", "source_type": "jsearch", "config": {"api_key": JSEARCH_KEY, **config},
        })
    assert resp.status_code == 422
    assert detail_fragment in resp.json()["detail"]
    assert JSEARCH_KEY not in resp.text
    mock_upsert.assert_not_called()


@pytest.mark.asyncio
async def test_update_jsearch_source_rejects_invalid_country(client):
    with (
        patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock,
              return_value=fake_config({"sources": [_jsearch_source()]})),
        patch("app.routers.pipeline.pipeline_configs_repo.upsert_for_user", new_callable=AsyncMock) as mock_upsert,
    ):
        resp = await client.put(f"{API}/sources/source-js", json={"config": {"country": "United Kingdom"}})
    assert resp.status_code == 422
    assert "country" in resp.json()["detail"]
    mock_upsert.assert_not_called()


@pytest.mark.asyncio
async def test_test_jsearch_source_without_api_key_lists_it_as_missing(client):
    source = _jsearch_source(config_encrypted={})
    with patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock,
               return_value=fake_config({"sources": [source]})):
        resp = await client.post(f"{API}/sources/source-js/test")
    assert resp.status_code == 422
    assert resp.json()["detail"]["missing_fields"] == ["api_key"]


async def _probar_jsearch(client, keywords: list, status_code: int = 200, content: bytes = b"") -> tuple:
    import httpx
    from app.services import job_scout_service

    calls = []

    class _Ctx:
        async def __aenter__(self):
            return httpx.Response(status_code, content=content, request=httpx.Request("GET", "https://jsearch.p.rapidapi.com/search-v2"))

        async def __aexit__(self, *exc):
            return False

    def fake_stream(self, method, url, **kwargs):
        calls.append(str(url))
        return _Ctx()

    doc = fake_config({"keywords": keywords, "sources": [_jsearch_source()]})
    with (
        patch("app.routers.pipeline.pipeline_configs_repo.get_by_user", new_callable=AsyncMock, return_value=doc),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
        patch.object(job_scout_service, "score_relevance_batch", new_callable=AsyncMock) as mock_score,
    ):
        resp = await client.post(f"{API}/sources/source-js/test")
    mock_score.assert_not_called()
    assert resp.status_code == 200
    assert JSEARCH_KEY not in resp.text
    return resp.json(), calls


@pytest.mark.asyncio
async def test_test_jsearch_source_reads_postings(client):
    import json
    content = json.dumps({"data": {"jobs": [
        {"job_title": "Agent", "employer_name": "Acme", "job_apply_link": "https://acme.example.com/1"},
        {"job_title": "Clerk", "employer_name": "Globex", "job_apply_link": "https://globex.example.com/2"},
    ]}}).encode()
    body, calls = await _probar_jsearch(client, ["BPO"], 200, content)
    assert body["ok"] is True
    assert body["postings_read"] == 2
    assert calls == ["https://jsearch.p.rapidapi.com/search-v2"]


@pytest.mark.asyncio
async def test_test_jsearch_source_reports_invalid_key(client):
    body, _ = await _probar_jsearch(client, ["BPO"], 403, b'{"message": "not subscribed"}')
    assert body["ok"] is False
    assert body["reason"] == "palabra clave «BPO»: clave de API inválida o sin suscripción a JSearch (HTTP 403): not subscribed"


@pytest.mark.asyncio
async def test_test_jsearch_source_404_includes_the_provider_reason(client):
    body, _ = await _probar_jsearch(client, ["BPO"], 404, b'{"message": "Endpoint \'/search\' does not exist"}')
    assert body["ok"] is False
    assert body["reason"] == "palabra clave «BPO»: JSearch respondió HTTP 404: Endpoint '/search' does not exist"


@pytest.mark.asyncio
async def test_test_jsearch_source_without_keywords_gives_a_clear_reason(client):
    body, calls = await _probar_jsearch(client, [])
    assert body["ok"] is False
    assert body["reason"] == "no hay palabras clave configuradas para la búsqueda"
    assert calls == []  # nothing is sent to the provider without a query


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
