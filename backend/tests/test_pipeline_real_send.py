"""/api/v1/pipeline/config — the real-send switch and daily limit
(RF-VTA-16), and the retired settings of the removed SMTP sending, which older
documents still hold: never returned, never accepted, and left in place (only
scripts/migrations/drop_smtp_fields.py removes them). In-memory Firestore
(tests/fake_firestore.py). Synthetic data only; no network."""
from __future__ import annotations

import pytest
from cryptography.fernet import Fernet

from app.core.pipeline_constants import (
    OUTREACH_DAILY_SEND_LIMIT_DEFAULT,
    OUTREACH_DAILY_SEND_LIMIT_MAX,
    RETIRED_SMTP_CONFIG_FIELDS,
)
from app.routers import pipeline as pipeline_router
from app.services import encryption_service, outreach_send_rules
from tests.conftest import FAKE_USER_SUB
from tests.fake_firestore import use_fake_firestore

API = "/api/v1/pipeline/config"
USER = FAKE_USER_SUB
SMTP_PASSWORD = "fake-smtp-password-42"


@pytest.fixture
def db(monkeypatch):
    monkeypatch.setattr(encryption_service.settings, "pipeline_encryption_key", Fernet.generate_key().decode())
    encryption_service._fernet.cache_clear()
    with use_fake_firestore() as fake:
        yield fake
    encryption_service._fernet.cache_clear()


def old_smtp_settings():
    """What a document saved while SMTP sending existed still holds."""
    return {
        "smtp_host": "smtp.example.test", "smtp_port": 587, "smtp_user": "smtp-user",
        "smtp_password_encrypted": encryption_service.encrypt(SMTP_PASSWORD),
        "sender_email": "ventas@example.test", "sender_name": "Equipo Ventas",
    }


def stored(db, **fields):
    db.put("pipeline_configs", USER, {"userId": USER, **fields})


def no_smtp_key(body):
    return not any(key.startswith("smtp") or key.startswith("sender_") for key in body)


# ── Switch and limit (from the former test_pipeline_smtp.py) ────────────────
async def test_a_new_user_has_sending_off_and_the_default_limit(client, db):
    body = (await client.get(API)).json()
    assert body["outreach_real_send_enabled"] is False
    assert body["outreach_daily_send_limit"] == OUTREACH_DAILY_SEND_LIMIT_DEFAULT
    assert no_smtp_key(body)


@pytest.mark.parametrize("server", [True, False])
async def test_the_server_switch_is_reported_read_only(client, db, monkeypatch, server):
    monkeypatch.setattr(outreach_send_rules.settings, "outreach_real_send_enabled", server)
    assert (await client.get(API)).json()["outreach_real_send_server_enabled"] is server
    resp = await client.put(API, json={"outreach_real_send_server_enabled": not server})
    assert resp.status_code == 200 and resp.json()["outreach_real_send_server_enabled"] is server


async def test_the_switch_and_the_limit_are_saved(client, db):
    resp = await client.put(API, json={"outreach_real_send_enabled": True, "outreach_daily_send_limit": 20})
    assert resp.status_code == 200
    doc = db.doc("pipeline_configs", USER)
    assert doc["outreach_real_send_enabled"] is True and doc["outreach_daily_send_limit"] == 20


@pytest.mark.parametrize("limit", [0, -1, OUTREACH_DAILY_SEND_LIMIT_MAX + 1])
async def test_a_limit_out_of_range_is_refused(client, db, limit):
    assert (await client.put(API, json={"outreach_daily_send_limit": limit})).status_code == 422


async def test_the_retired_max_emails_per_day_is_not_revived(client, db):
    stored(db, max_emails_per_day=999)
    body = (await client.get(API)).json()
    assert "max_emails_per_day" not in body
    assert body["outreach_daily_send_limit"] == OUTREACH_DAILY_SEND_LIMIT_DEFAULT


# ── Retired SMTP settings ────────────────────────────────────────────────────
def test_every_smtp_setting_is_retired():
    assert set(RETIRED_SMTP_CONFIG_FIELDS) == {
        "smtp_host", "smtp_port", "smtp_user", "smtp_password_encrypted", "sender_email", "sender_name",
    }
    assert set(RETIRED_SMTP_CONFIG_FIELDS) <= set(pipeline_router.RETIRED_CONFIG_FIELDS)
    assert {"auto_send_threshold", "max_emails_per_day"} <= set(pipeline_router.RETIRED_CONFIG_FIELDS)
    assert not any(key.startswith("smtp") or key.startswith("sender_") for key in pipeline_router._default_config())


async def test_stored_smtp_settings_are_never_returned(client, db):
    old = old_smtp_settings()
    stored(db, **old)
    for resp in (await client.get(API), await client.put(API, json={"keywords": ["BPO"]})):
        assert resp.status_code == 200 and no_smtp_key(resp.json())
        for value in (SMTP_PASSWORD, old["smtp_password_encrypted"], old["smtp_host"], old["sender_email"]):
            assert value not in resp.text


async def test_a_put_with_smtp_settings_stores_none_of_them(client, db):
    resp = await client.put(API, json={
        "smtp_host": "smtp.example.test", "smtp_port": 465, "smtp_user": "u", "smtp_password": SMTP_PASSWORD,
        "smtp_password_encrypted": "x", "sender_email": "ventas@example.test", "sender_name": "Equipo",
        "keywords": ["BPO"],
    })
    assert resp.status_code == 200
    doc = db.doc("pipeline_configs", USER)
    assert doc["keywords"] == ["BPO"]
    assert not any(key.startswith("smtp") or key.startswith("sender_") for key in doc)
    assert SMTP_PASSWORD not in str(db.writes)


async def test_a_put_leaves_the_stored_smtp_settings_for_the_migration_script(client, db):
    old = old_smtp_settings()
    stored(db, **old)
    assert (await client.put(API, json={"keywords": ["BPO"]})).status_code == 200
    doc = db.doc("pipeline_configs", USER)
    assert {field: doc[field] for field in RETIRED_SMTP_CONFIG_FIELDS} == old   # untouched


async def test_the_smtp_connection_test_endpoint_is_gone(client, db):
    resp = await client.post(f"{API}/smtp/test")
    assert resp.status_code in (404, 405)
