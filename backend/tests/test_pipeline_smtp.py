"""/api/v1/pipeline/config — SMTP account indicator, real-send switch, daily
limit and POST /config/smtp/test (RF-VTA-16, envío real). In-memory Firestore
(tests/fake_firestore.py); the SMTP connection is faked or never reached.
Synthetic data only; no network."""
from __future__ import annotations

import socket
from unittest.mock import AsyncMock, patch

import pytest
from cryptography.fernet import Fernet

from app.core import url_safety
from app.core.pipeline_constants import OUTREACH_DAILY_SEND_LIMIT_DEFAULT, OUTREACH_DAILY_SEND_LIMIT_MAX
from app.services import encryption_service, smtp_service
from app.services.smtp_service import SmtpError
from tests.conftest import FAKE_USER_SUB
from tests.fake_firestore import use_fake_firestore

API = "/api/v1/pipeline/config"
USER = FAKE_USER_SUB
SMTP_PASSWORD = "fake-smtp-password-42"


def resolves_to(ip):
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]
    return patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo)


@pytest.fixture
def db(monkeypatch):
    monkeypatch.setattr(encryption_service.settings, "pipeline_encryption_key", Fernet.generate_key().decode())
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", False)
    encryption_service._fernet.cache_clear()
    with use_fake_firestore() as fake, resolves_to("93.184.216.34"):
        yield fake
    encryption_service._fernet.cache_clear()


def complete_account(db, **overrides):
    db.put("pipeline_configs", USER, {
        "userId": USER, "smtp_host": "smtp.example.test", "smtp_port": 587, "smtp_user": "smtp-user",
        "smtp_password_encrypted": encryption_service.encrypt(SMTP_PASSWORD),
        "sender_email": "ventas@example.test", "sender_name": "Equipo Ventas", **overrides,
    })


# ── Indicator ────────────────────────────────────────────────────────────────
async def test_a_new_user_has_an_incomplete_account_and_sending_off(client, db):
    body = (await client.get(API)).json()
    assert body["smtp_configured"] is False
    assert body["smtp_missing_fields"] == ["smtp_host", "smtp_user", "smtp_password", "sender_email"]
    assert body["outreach_real_send_enabled"] is False
    assert body["outreach_daily_send_limit"] == OUTREACH_DAILY_SEND_LIMIT_DEFAULT


async def test_a_complete_account_is_configured_and_no_secret_is_returned(client, db):
    complete_account(db)
    resp = await client.get(API)
    body = resp.json()
    assert body["smtp_configured"] is True and body["smtp_missing_fields"] == []
    assert body["smtp_password_configured"] is True
    assert SMTP_PASSWORD not in resp.text
    assert {k for k in body if "password" in k} == {"smtp_password_configured"}


@pytest.mark.parametrize("field, change", [
    ("smtp_host", {"smtp_host": ""}), ("smtp_user", {"smtp_user": ""}),
    ("smtp_password", {"smtp_password_encrypted": ""}), ("sender_email", {"sender_email": ""}),
])
async def test_each_missing_field_is_reported(client, db, field, change):
    complete_account(db, **change)
    body = (await client.get(API)).json()
    assert body["smtp_configured"] is False and body["smtp_missing_fields"] == [field]


@pytest.mark.parametrize("server", [True, False])
async def test_the_server_switch_is_reported_read_only(client, db, monkeypatch, server):
    monkeypatch.setattr(smtp_service.settings, "outreach_real_send_enabled", server)
    assert (await client.get(API)).json()["outreach_real_send_server_enabled"] is server
    resp = await client.put(API, json={"outreach_real_send_server_enabled": not server})
    assert resp.status_code == 200 and resp.json()["outreach_real_send_server_enabled"] is server


# ── Switch and limit ─────────────────────────────────────────────────────────
async def test_the_switch_and_the_limit_are_saved(client, db):
    resp = await client.put(API, json={"outreach_real_send_enabled": True, "outreach_daily_send_limit": 20})
    assert resp.status_code == 200
    stored = db.doc("pipeline_configs", USER)
    assert stored["outreach_real_send_enabled"] is True and stored["outreach_daily_send_limit"] == 20


@pytest.mark.parametrize("limit", [0, -1, OUTREACH_DAILY_SEND_LIMIT_MAX + 1])
async def test_a_limit_out_of_range_is_refused(client, db, limit):
    assert (await client.put(API, json={"outreach_daily_send_limit": limit})).status_code == 422


async def test_the_retired_max_emails_per_day_is_not_revived(client, db):
    complete_account(db, max_emails_per_day=999)
    body = (await client.get(API)).json()
    assert "max_emails_per_day" not in body
    assert body["outreach_daily_send_limit"] == OUTREACH_DAILY_SEND_LIMIT_DEFAULT


async def test_the_smtp_host_is_stripped(client, db):
    await client.put(API, json={"smtp_host": "  smtp.example.test  "})
    assert db.doc("pipeline_configs", USER)["smtp_host"] == "smtp.example.test"


# ── POST /config/smtp/test ───────────────────────────────────────────────────
async def test_connection_test_with_an_incomplete_account(client, db):
    complete_account(db, smtp_user="")
    with patch.object(smtp_service, "check_connection", new_callable=AsyncMock) as check:
        resp = await client.post(f"{API}/smtp/test")
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "smtp_not_configured", "missing": ["smtp_user"]}
    check.assert_not_awaited()


async def test_connection_test_success_uses_the_decrypted_password(client, db):
    complete_account(db)
    with patch.object(smtp_service, "check_connection", new_callable=AsyncMock) as check:
        resp = await client.post(f"{API}/smtp/test")
    assert resp.status_code == 200 and resp.json() == {"ok": True}
    account, password = check.await_args.args
    assert account.host == "smtp.example.test" and password == SMTP_PASSWORD
    assert SMTP_PASSWORD not in resp.text


async def test_connection_test_reports_a_failure_code(client, db):
    complete_account(db)
    with patch.object(smtp_service, "check_connection", new_callable=AsyncMock,
                      side_effect=SmtpError(502, "smtp_auth_failed")):
        resp = await client.post(f"{API}/smtp/test")
    assert resp.status_code == 502 and resp.json()["detail"] == {"code": "smtp_auth_failed"}


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.1.2.3", "192.168.50.1", "169.254.169.254"])
async def test_connection_test_refuses_an_internal_host_without_connecting(client, db, ip):
    complete_account(db)
    with resolves_to(ip), patch.object(smtp_service.aiosmtplib, "SMTP", side_effect=AssertionError("no connect")):
        resp = await client.post(f"{API}/smtp/test")
    assert resp.status_code == 422 and resp.json()["detail"] == {"code": "smtp_host_blocked"}


async def test_connection_test_allows_an_internal_host_with_the_switch_in_test(client, db, monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", True)
    monkeypatch.setattr(smtp_service.settings, "app_env", "test")
    complete_account(db, smtp_host="127.0.0.1")
    with patch.object(smtp_service, "check_connection", new_callable=AsyncMock) as check:
        assert (await client.post(f"{API}/smtp/test")).status_code == 200
    check.assert_awaited_once()


async def test_connection_test_keeps_internal_hosts_blocked_in_production(client, db, monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", True)
    monkeypatch.setattr(smtp_service.settings, "app_env", "production")
    complete_account(db)
    with resolves_to("127.0.0.1"), patch.object(smtp_service.aiosmtplib, "SMTP", side_effect=AssertionError):
        resp = await client.post(f"{API}/smtp/test")
    assert resp.json()["detail"] == {"code": "smtp_host_blocked"}


async def test_connection_test_with_an_unreadable_password(client, db):
    complete_account(db, smtp_password_encrypted=Fernet(Fernet.generate_key()).encrypt(b"x").decode())
    resp = await client.post(f"{API}/smtp/test")
    assert resp.status_code == 409 and resp.json()["detail"] == {"code": "smtp_credentials_unreadable"}
