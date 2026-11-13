"""POST /api/v1/outreach-emails/{id}/send, GET /send-status and
/do-not-contact (RF-VTA-16, envío real). Real repositories over an in-memory
Firestore (tests/fake_firestore.py), a fake SMTP sender (records calls, can
fail) and a fake LLM. Synthetic data only: nothing is sent, no network."""
from __future__ import annotations

import asyncio
import itertools
import json
import logging
import socket
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet

from app.core import url_safety
from app.core.pipeline_constants import OUTREACH_UNSUBSCRIBE_LINE
from app.services import encryption_service, smtp_service
from app.services.firestore_service import (
    OutreachSendCountersRepo,
    contacts_repo,
    do_not_contact_repo,
    leads_repo,
    outreach_emails_repo,
    outreach_send_counters_repo,
    pipeline_configs_repo,
)
from app.services.outreach_email_service import OutreachEmailService
from app.services.smtp_service import SmtpError
from tests.conftest import FAKE_USER_SUB
from tests.fake_firestore import use_fake_firestore

API = "/api/v1/outreach-emails"
USER = FAKE_USER_SUB
OTHER = "someone-else"
T0 = datetime(2026, 11, 12, 15, 0, tzinfo=timezone.utc)
RECIPIENT = "ana.perez@example.test"
SMTP_PASSWORD = "fake-smtp-password-42"

LEAD = {"user_id": USER, "status": "approved", "job_title": "Jefa de Operaciones", "company_name": "Acme Logística"}
CONTACT = {
    "user_id": USER, "lead_id": "lead-1", "full_name": "Ana Pérez", "job_title": "Gerente de Personas",
    "company": "Acme Logística", "email": RECIPIENT, "role": "hr_recruiter",
    "review_status": "not_required", "confidence_score": 0.9,
}
EMAIL = {
    "user_id": USER, "lead_id": "lead-1", "contact_id": "c-1", "job_title": "Jefa de Operaciones",
    "company_name": "Acme Logística", "contact_name": "Ana Pérez", "to_email": RECIPIENT,
    "createdAt": T0 - timedelta(hours=1), "updatedAt": T0 - timedelta(hours=1),
    "contact_review_status": "not_required", "subject": "Vacante de Jefa de Operaciones",
    "body": "Hola Ana,\n\nTexto del correo.\n\nEquipo NoonDalton", "status": "approved", "language": "es",
    "history": [{"action": "generate", "at": T0, "by": USER, "from_status": None, "to_status": "pending_review"},
                {"action": "approve", "at": T0, "by": USER, "from_status": "pending_review", "to_status": "approved"}],
}


def smtp_config(**overrides):
    return {
        "userId": USER, "smtp_host": "smtp.example.test", "smtp_port": 587, "smtp_user": "smtp-user",
        "smtp_password_encrypted": encryption_service.encrypt(SMTP_PASSWORD), "sender_email": "ventas@example.test",
        "sender_name": "Equipo Ventas", "outreach_real_send_enabled": True, "outreach_daily_send_limit": 50,
        **overrides,
    }


class FakeSender:
    """Stands in for smtp_service.deliver."""

    def __init__(self):
        self.calls = []
        self.errors = []  # raised in order, one per call
        self.gate = None  # an asyncio.Event: hold the delivery until it is set

    async def __call__(self, account, password, message):
        self.calls.append({"account": account, "password": password, "message": message})
        if self.gate is not None:
            await asyncio.wait_for(self.gate.wait(), timeout=5)
        if self.errors:
            raise self.errors.pop(0)


class FakeLLM:
    async def __call__(self, prompt, **kwargs):
        return json.dumps({"subject": "Asunto", "body": "Cuerpo"})


class World:
    def __init__(self, db, sender, clock):
        self.db, self.sender, self.clock = db, sender, clock

    def email(self, email_id="e-1"):
        return self.db.doc("outreach_emails", email_id)

    def lead(self):
        return self.db.doc("leads", "lead-1")

    def sent_today(self, day=None):
        doc_id = OutreachSendCountersRepo.doc_id_for(USER, day or OutreachSendCountersRepo.day_of(self.clock["t"]))
        return (self.db.doc("outreach_send_counters", doc_id) or {}).get("count", 0)

    def set_count(self, count):
        day = OutreachSendCountersRepo.day_of(self.clock["t"])
        doc_id = OutreachSendCountersRepo.doc_id_for(USER, day)
        self.db.put("outreach_send_counters", doc_id, {"user_id": USER, "day": day, "count": count})


@pytest.fixture
def encryption_key(monkeypatch):
    monkeypatch.setattr(encryption_service.settings, "pipeline_encryption_key", Fernet.generate_key().decode())
    encryption_service._fernet.cache_clear()
    yield
    encryption_service._fernet.cache_clear()


def resolves_to(ip):
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]
    return patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo)


@pytest.fixture
def world(encryption_key, monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "outreach_real_send_enabled", True)
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", False)
    monkeypatch.setattr(smtp_service.settings, "smtp_timeout_seconds", 20.0)
    with use_fake_firestore() as db, resolves_to("93.184.216.34"):
        db.put("leads", "lead-1", LEAD)
        db.put("contacts", "c-1", CONTACT)
        db.put("outreach_emails", "e-1", EMAIL)
        db.put("pipeline_configs", USER, smtp_config())
        sender = FakeSender()
        now = {"t": T0}
        ids = (f"id-{n}" for n in itertools.count(1))
        service = OutreachEmailService(
            leads_repo, contacts_repo, outreach_emails_repo, FakeLLM(), lambda: now["t"], lambda: next(ids),
            configs=pipeline_configs_repo, do_not_contact=do_not_contact_repo,
            send_counters=outreach_send_counters_repo, send_mail=sender,
        )
        with (
            patch("app.services.outreach_email_service.get_service", return_value=service),
            patch("app.middleware.audit.settings.audit_log_enabled", False),
        ):
            yield World(db, sender, now)


async def send(client, email_id="e-1", confirm=RECIPIENT, **body):
    return await client.post(f"{API}/{email_id}/send", json={"confirm_to_email": confirm, **body})


def code_of(resp):
    return resp.json()["detail"]["code"]


# ── Success ──────────────────────────────────────────────────────────────────
async def test_send_delivers_and_closes_the_email(client, world):
    resp = await send(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "sent" and body["send_method"] == "smtp" and body["lead_status"] == "sent"
    assert body["sent_by"] == USER and body["sent_by_name"] == "Test User"
    assert body["send_lock"] is None and body["last_send_error"] is None and body["send_attempts"] == 1
    assert body["unsubscribe_line"] == OUTREACH_UNSUBSCRIBE_LINE["es"]
    assert SMTP_PASSWORD not in resp.text

    stored = world.email()
    assert stored["status"] == "sent" and stored["send_method"] == "smtp" and "send_lock" not in stored
    assert stored["smtp_message_id"].endswith("@example.test>")
    last = stored["history"][-1]
    assert last["action"] == "send" and last["to_status"] == "sent"
    assert last["send_method"] == "smtp" and last["smtp_message_id"] == stored["smtp_message_id"]
    assert world.lead()["status"] == "sent"
    assert world.sent_today() == 1

    [call] = world.sender.calls
    assert call["password"] == SMTP_PASSWORD
    message = call["message"]
    assert message["To"] == RECIPIENT and message["Message-ID"] == stored["smtp_message_id"]
    assert message.get_content().rstrip().endswith(OUTREACH_UNSUBSCRIBE_LINE["es"])


async def test_the_confirmation_ignores_case_and_spaces(client, world):
    assert (await send(client, confirm="  ANA.Perez@Example.TEST ")).status_code == 200


async def test_mark_sent_is_manual_and_still_works(client, world):
    resp = await client.patch(f"{API}/e-1/mark-sent")
    assert resp.status_code == 200
    assert resp.json()["send_method"] == "manual" and world.email()["send_method"] == "manual"
    assert world.sender.calls == []


# ── Refusals before anything is reserved ─────────────────────────────────────
def assert_nothing_reserved(world):
    stored = world.email()
    assert stored["status"] == "approved" and "send_lock" not in stored and "send_attempts" not in stored
    assert world.sent_today() == 0 and world.sender.calls == []
    assert world.db.writes == []


@pytest.mark.parametrize("status", ["pending_review", "sent", "rejected"])
async def test_only_approved_emails_are_sent(client, world, status):
    world.db.data["outreach_emails"]["e-1"]["status"] = status
    resp = await send(client)
    assert resp.status_code == 422 and code_of(resp) == "invalid_email_transition"
    assert world.sender.calls == [] and world.db.writes == []


@pytest.mark.parametrize("change", [{"review_status": "pending"}, {"review_status": "rejected"}, {"lead_id": "lead-2"}])
async def test_a_contact_not_approved_blocks_the_send(client, world, change):
    world.db.data["contacts"]["c-1"].update(change)
    resp = await send(client)
    assert resp.status_code == 422 and code_of(resp) == "contact_not_approved"
    assert_nothing_reserved(world)


@pytest.mark.parametrize("server, user", [(False, True), (True, False), (False, False)])
async def test_both_switches_are_required(client, world, monkeypatch, server, user):
    monkeypatch.setattr(smtp_service.settings, "outreach_real_send_enabled", server)
    world.db.data["pipeline_configs"][USER]["outreach_real_send_enabled"] = user
    resp = await send(client)
    assert resp.status_code == 403 and code_of(resp) == "real_send_disabled"
    assert_nothing_reserved(world)


@pytest.mark.parametrize("field, change", [
    ("smtp_host", {"smtp_host": ""}),
    ("smtp_port", {"smtp_port": 0}),
    ("smtp_user", {"smtp_user": " "}),
    ("smtp_password", {"smtp_password_encrypted": ""}),
    ("sender_email", {"sender_email": ""}),
])
async def test_an_incomplete_account_is_smtp_not_configured(client, world, field, change):
    world.db.data["pipeline_configs"][USER].update(change)
    resp = await send(client)
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "smtp_not_configured", "missing": [field]}
    assert_nothing_reserved(world)


async def test_without_any_config_everything_is_missing(client, world):
    world.db.data["pipeline_configs"][USER] = {"userId": USER, "outreach_real_send_enabled": True}
    resp = await send(client)
    assert resp.json()["detail"]["missing"] == ["smtp_host", "smtp_user", "smtp_password", "sender_email"]


async def test_an_unreadable_password(client, world):
    foreign = Fernet(Fernet.generate_key()).encrypt(b"x").decode()
    world.db.data["pipeline_configs"][USER]["smtp_password_encrypted"] = foreign
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "smtp_credentials_unreadable"
    assert_nothing_reserved(world)


async def test_without_the_encryption_key(client, world, monkeypatch):
    monkeypatch.setattr(encryption_service.settings, "pipeline_encryption_key", "")
    encryption_service._fernet.cache_clear()
    resp = await send(client)
    assert resp.status_code == 503 and code_of(resp) == "encryption_not_configured"
    assert_nothing_reserved(world)


async def test_a_wrong_confirmation_is_recipient_mismatch(client, world):
    resp = await send(client, confirm="otra@example.test")
    assert resp.status_code == 409 and code_of(resp) == "recipient_mismatch"
    assert_nothing_reserved(world)


async def test_a_contact_whose_address_changed_is_recipient_changed(client, world):
    world.db.data["contacts"]["c-1"]["email"] = "nueva@example.test"
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "recipient_changed"
    assert_nothing_reserved(world)


async def test_a_malformed_recipient_is_refused(client, world):
    world.db.data["contacts"]["c-1"]["email"] = "no-es-un-correo"
    world.db.data["outreach_emails"]["e-1"]["to_email"] = "no-es-un-correo"
    resp = await send(client, confirm="no-es-un-correo")
    assert resp.status_code == 422 and code_of(resp) == "invalid_recipient"
    assert_nothing_reserved(world)


@pytest.mark.parametrize("kind, value", [("email", RECIPIENT), ("domain", "example.test")])
async def test_the_do_not_contact_list_blocks_the_send(client, world, kind, value):
    await do_not_contact_repo.add(USER, kind, value, created_by=USER)
    world.db.writes.clear()
    resp = await send(client)
    assert resp.status_code == 422 and code_of(resp) == "do_not_contact"
    assert_nothing_reserved(world)


async def test_another_users_do_not_contact_entry_does_not_count(client, world):
    await do_not_contact_repo.add(OTHER, "email", RECIPIENT, created_by=OTHER)
    assert (await send(client)).status_code == 200


@pytest.mark.parametrize("ip", ["10.0.0.7", "192.168.0.10", "127.0.0.1", "169.254.169.254"])
async def test_an_internal_smtp_host_is_blocked(client, world, ip):
    with resolves_to(ip):
        resp = await send(client)
    assert resp.status_code == 422 and code_of(resp) == "smtp_host_blocked"
    assert_nothing_reserved(world)


async def test_an_internal_host_is_allowed_with_the_switch_in_test(client, world, monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", True)
    monkeypatch.setattr(smtp_service.settings, "app_env", "test")
    with resolves_to("127.0.0.1"):
        assert (await send(client)).status_code == 200


async def test_the_switch_does_not_open_internal_hosts_in_production(client, world, monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", True)
    monkeypatch.setattr(smtp_service.settings, "app_env", "production")
    # In production a .test recipient is refused first: use a regular domain.
    world.db.data["contacts"]["c-1"]["email"] = "ana@example.com"
    world.db.data["outreach_emails"]["e-1"]["to_email"] = "ana@example.com"
    with resolves_to("127.0.0.1"):
        resp = await send(client, confirm="ana@example.com")
    assert code_of(resp) == "smtp_host_blocked"
    assert_nothing_reserved(world)


async def test_an_unresolvable_smtp_host(client, world):
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=socket.gaierror("nope")):
        resp = await send(client)
    assert resp.status_code == 422 and code_of(resp) == "smtp_host_unresolvable"
    assert_nothing_reserved(world)


async def test_someone_elses_or_a_missing_email(client, world):
    assert (await send(client, email_id="nope")).status_code == 404
    world.db.data["outreach_emails"]["e-1"]["user_id"] = OTHER
    assert (await send(client)).status_code == 403
    assert world.sender.calls == []


async def test_the_body_needs_a_confirmation(client, world):
    resp = await client.post(f"{API}/e-1/send", json={})
    assert resp.status_code == 422 and world.sender.calls == []


# ── Daily quota ──────────────────────────────────────────────────────────────
async def test_the_daily_limit_is_enforced(client, world):
    world.db.data["pipeline_configs"][USER]["outreach_daily_send_limit"] = 3
    world.set_count(3)
    resp = await send(client)
    assert resp.status_code == 429 and code_of(resp) == "daily_limit_reached"
    assert world.sender.calls == [] and "send_lock" not in world.email()


async def test_the_quota_starts_over_the_next_day(client, world):
    world.db.data["pipeline_configs"][USER]["outreach_daily_send_limit"] = 1
    world.set_count(1)
    world.clock["t"] = T0 + timedelta(days=1)
    assert (await send(client)).status_code == 200
    assert world.sent_today() == 1


async def test_a_stored_limit_above_the_cap_is_capped(client, world):
    world.db.data["pipeline_configs"][USER]["outreach_daily_send_limit"] = 1000
    world.set_count(100)
    assert code_of(await send(client)) == "daily_limit_reached"


# ── Failures ─────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("code", ["smtp_auth_failed", "smtp_recipient_refused", "smtp_unavailable", "smtp_host_blocked"])
async def test_a_failure_before_data_frees_the_lock_and_the_quota(client, world, code):
    world.sender.errors = [SmtpError(502 if code != "smtp_host_blocked" else 422, code)]
    resp = await send(client)
    assert code_of(resp) == code
    stored = world.email()
    assert stored["status"] == "approved" and "send_lock" not in stored
    assert stored["last_send_error"]["code"] == code and stored["send_attempts"] == 1
    assert world.sent_today() == 0
    assert world.lead()["status"] == "approved"

    again = await send(client)  # a retry is allowed right away
    assert again.status_code == 200 and "last_send_error" not in world.email()
    assert world.sent_today() == 1 and len(world.sender.calls) == 2


async def test_a_timeout_during_data_is_uncertain(client, world):
    world.sender.errors = [SmtpError(504, "smtp_timeout", uncertain=True)]
    resp = await send(client)
    assert resp.status_code == 504 and code_of(resp) == "smtp_timeout"
    stored = world.email()
    assert stored["status"] == "approved" and stored["send_lock"]["uncertain"] is True
    assert stored["last_send_error"]["code"] == "smtp_timeout"
    assert world.sent_today() == 1  # the uncertain attempt keeps its slot
    assert world.lead()["status"] == "approved"

    plain = await send(client)
    assert plain.status_code == 409 and code_of(plain) == "send_uncertain"
    assert len(world.sender.calls) == 1


async def test_a_forced_retry_after_a_timeout_sends_again_with_the_same_message_id(client, world):
    world.sender.errors = [SmtpError(504, "smtp_timeout", uncertain=True)]
    await send(client)
    first_id = world.email()["smtp_message_id"]
    resp = await send(client, force_retry=True)
    assert resp.status_code == 200 and resp.json()["status"] == "sent"
    assert len(world.sender.calls) == 2
    assert world.sender.calls[1]["message"]["Message-ID"] == first_id == world.email()["smtp_message_id"]
    assert world.email()["send_attempts"] == 2 and world.sent_today() == 2


async def test_force_retry_without_an_uncertain_lock_is_ignored(client, world):
    resp = await send(client, force_retry=True)
    assert resp.status_code == 200 and len(world.sender.calls) == 1


async def test_an_unexpected_delivery_failure_is_treated_as_uncertain(client, world):
    world.sender.errors = [RuntimeError("boom")]
    resp = await send(client)
    assert resp.status_code == 504 and code_of(resp) == "smtp_timeout"
    assert world.email()["send_lock"]["uncertain"] is True


async def test_logs_never_carry_the_password_or_the_recipient(client, world, caplog):
    world.sender.errors = [SmtpError(502, "smtp_auth_failed")]
    with caplog.at_level(logging.DEBUG):
        resp = await send(client)
    assert SMTP_PASSWORD not in caplog.text and RECIPIENT not in caplog.text
    assert SMTP_PASSWORD not in resp.text


# ── Send lock ────────────────────────────────────────────────────────────────
async def _while_delivering(world, client, request):
    """Start a send, wait until it is inside the SMTP delivery, run `request`
    (another tab) meanwhile, then let the delivery finish."""
    world.sender.gate = asyncio.Event()
    first = asyncio.create_task(send(client))
    for _ in range(200):
        if world.sender.calls:
            break
        await asyncio.sleep(0.01)
    assert len(world.sender.calls) == 1
    other = await request()
    world.sender.gate.set()
    return await first, other


async def test_two_sends_at_once_deliver_only_once(client, world):
    first, second = await _while_delivering(world, client, lambda: send(client))
    assert first.status_code == 200
    assert second.status_code == 409 and code_of(second) == "send_in_progress"
    assert len(world.sender.calls) == 1 and world.sent_today() == 1


@pytest.mark.parametrize("action", ["mark-sent", "reject"])
async def test_marking_while_another_tab_sends_is_refused(client, world, action):
    first, other = await _while_delivering(world, client, lambda: client.patch(f"{API}/e-1/{action}"))
    assert other.status_code == 409 and code_of(other) == "send_in_progress"
    assert first.status_code == 200 and world.email()["send_method"] == "smtp"


def held_lock(world, age_seconds=5, uncertain=False):
    world.db.data["outreach_emails"]["e-1"]["send_lock"] = {
        "id": "other-tab", "at": T0 - timedelta(seconds=age_seconds), "uncertain": uncertain,
    }


async def test_a_held_lock_refuses_a_send(client, world):
    held_lock(world)
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "send_in_progress"
    assert world.sender.calls == [] and world.sent_today() == 0


async def test_a_stale_lock_is_replaced(client, world):
    held_lock(world, age_seconds=41)  # 2 × the 20 s SMTP timeout
    assert (await send(client)).status_code == 200


@pytest.mark.parametrize("action", ["mark-sent", "reject"])
async def test_a_held_lock_refuses_mark_sent_and_reject(client, world, action):
    held_lock(world)
    resp = await client.patch(f"{API}/e-1/{action}")
    assert resp.status_code == 409 and code_of(resp) == "send_in_progress"
    stored = world.email()
    assert stored["status"] == "approved" and stored["send_lock"]["id"] == "other-tab"
    assert world.lead()["status"] == "approved"


async def test_mark_sent_after_a_timeout_frees_the_lock(client, world):
    world.sender.errors = [SmtpError(504, "smtp_timeout", uncertain=True)]
    await send(client)
    resp = await client.patch(f"{API}/e-1/mark-sent")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "sent" and body["send_method"] == "manual" and body["send_lock"] is None
    assert body["lead_status"] == "sent"
    stored = world.email()
    assert "send_lock" not in stored and stored["history"][-1]["send_error"] == "smtp_timeout"


async def test_reject_after_a_timeout_frees_the_lock(client, world):
    world.sender.errors = [SmtpError(504, "smtp_timeout", uncertain=True)]
    await send(client)
    resp = await client.patch(f"{API}/e-1/reject")
    assert resp.status_code == 200 and resp.json()["status"] == "rejected"
    assert "send_lock" not in world.email()


async def test_mark_sent_clears_a_stale_lock(client, world):
    held_lock(world, age_seconds=600)
    resp = await client.patch(f"{API}/e-1/mark-sent")
    assert resp.status_code == 200 and "send_lock" not in world.email()


# ── Send status ──────────────────────────────────────────────────────────────
async def test_send_status_of_a_complete_account(client, world):
    world.set_count(2)
    resp = await client.get(f"{API}/send-status")
    assert resp.status_code == 200
    assert resp.json() == {
        "smtp_configured": True, "smtp_missing_fields": [], "server_send_enabled": True,
        "user_send_enabled": True, "real_send_enabled": True, "daily_limit": 50, "sent_today": 2,
    }


async def test_send_status_of_an_incomplete_account_has_no_secret(client, world, monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "outreach_real_send_enabled", False)
    world.db.data["pipeline_configs"][USER].update({"smtp_password_encrypted": "", "smtp_host": ""})
    body = (await client.get(f"{API}/send-status")).json()
    assert body["smtp_configured"] is False and body["smtp_missing_fields"] == ["smtp_host", "smtp_password"]
    assert body["server_send_enabled"] is False and body["real_send_enabled"] is False
    assert not any("password" in key for key in body)


async def test_send_status_without_a_config(client, world):
    del world.db.data["pipeline_configs"][USER]
    body = (await client.get(f"{API}/send-status")).json()
    assert body["smtp_configured"] is False and body["user_send_enabled"] is False and body["daily_limit"] == 50


# ── Unsubscribe line in every response ───────────────────────────────────────
@pytest.mark.parametrize("language", ["en", "es", "pt", None])
async def test_every_email_shows_its_unsubscribe_line(client, world, language):
    world.db.data["outreach_emails"]["e-1"]["language"] = language
    expected = OUTREACH_UNSUBSCRIBE_LINE[language or "en"]
    assert (await client.get(f"{API}/e-1")).json()["unsubscribe_line"] == expected
    assert (await client.get(API)).json()["items"][0]["unsubscribe_line"] == expected


# ── Do-not-contact list ──────────────────────────────────────────────────────
async def test_add_from_an_email_takes_its_recipient(client, world):
    resp = await client.post(f"{API}/do-not-contact", json={"email_id": "e-1", "reason": "pidió no recibir más"})
    assert resp.status_code == 201
    entry = resp.json()
    assert entry["kind"] == "email" and entry["value"] == RECIPIENT and entry["source_email_id"] == "e-1"
    assert RECIPIENT not in entry["id"]  # the id is a hash, not the address
    assert code_of(await send(client)) == "do_not_contact"
    again = await client.post(f"{API}/do-not-contact", json={"email_id": "e-1"})
    assert again.json()["id"] == entry["id"]  # idempotent


async def test_add_from_someone_elses_or_a_missing_email(client, world):
    assert (await client.post(f"{API}/do-not-contact", json={"email_id": "nope"})).status_code == 404
    world.db.data["outreach_emails"]["e-1"]["user_id"] = OTHER
    assert (await client.post(f"{API}/do-not-contact", json={"email_id": "e-1"})).status_code == 403
    assert world.db.data.get("do_not_contact", {}) == {}


@pytest.mark.parametrize("payload", [
    {}, {"email_id": "e-1", "domain": "example.test"}, {"email": "no-es-correo"}, {"domain": "sin punto"},
])
async def test_add_needs_exactly_one_valid_value(client, world, payload):
    resp = await client.post(f"{API}/do-not-contact", json=payload)
    assert resp.status_code == 422 and code_of(resp) == "invalid_do_not_contact"


async def test_list_and_remove(client, world):
    created = (await client.post(f"{API}/do-not-contact", json={"domain": "@Example.TEST"})).json()
    assert created["kind"] == "domain" and created["value"] == "example.test"
    await do_not_contact_repo.add(OTHER, "email", "x@example.test", created_by=OTHER)
    listed = (await client.get(f"{API}/do-not-contact")).json()
    assert listed["total"] == 1 and listed["items"][0]["id"] == created["id"]
    assert (await client.delete(f"{API}/do-not-contact/{created['id']}")).status_code == 204
    assert (await client.get(f"{API}/do-not-contact")).json()["total"] == 0
    assert (await send(client)).status_code == 200


async def test_remove_someone_elses_entry_is_404(client, world):
    entry = await do_not_contact_repo.add(OTHER, "email", "x@example.test", created_by=OTHER)
    resp = await client.delete(f"{API}/do-not-contact/{entry['id']}")
    assert resp.status_code == 404 and code_of(resp) == "do_not_contact_not_found"
    assert world.db.doc("do_not_contact", entry["id"]) is not None


async def test_generating_for_a_blocked_recipient_warns(client, world):
    world.db.put("contacts", "c-2", {**CONTACT, "email": "bloqueado@example.test"})
    await do_not_contact_repo.add(USER, "email", "bloqueado@example.test", created_by=USER)
    resp = await client.post(API, json={"lead_id": "lead-1", "contact_id": "c-2"})
    assert resp.status_code == 201 and "do_not_contact" in resp.json()["warnings"]


# ── Reserved .test domains only outside production ──────────────────────────
async def test_a_test_domain_recipient_is_refused_in_production(client, world, monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "app_env", "production")
    resp = await send(client)
    assert resp.status_code == 422 and code_of(resp) == "invalid_recipient"
    assert_nothing_reserved(world)


async def test_a_test_domain_recipient_is_accepted_outside_production(client, world, monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "app_env", "test")
    assert (await send(client)).status_code == 200


async def test_a_test_domain_do_not_contact_entry_is_refused_in_production(client, world, monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "app_env", "production")
    resp = await client.post(f"{API}/do-not-contact", json={"email": "x@example.test"})
    assert resp.status_code == 422 and code_of(resp) == "invalid_do_not_contact"
    monkeypatch.setattr(smtp_service.settings, "app_env", "development")
    assert (await client.post(f"{API}/do-not-contact", json={"email": "x@example.test"})).status_code == 201
