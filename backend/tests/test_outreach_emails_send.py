"""POST /api/v1/outreach-emails/{id}/send, GET /send-status and
/do-not-contact (RF-VTA-16, envío real desde el buzón conectado).

Real repositories over an in-memory Firestore (tests/fake_firestore.py), the
real MailConnectionService with a connected mailbox, graph_client over
Microsoft faked in-process (tests/fake_microsoft.py: drafts, sends and reads
of messages, with failures on demand) and a fake LLM. Synthetic data only:
nothing is sent, no network."""
from __future__ import annotations

import asyncio
import itertools
import json
import logging
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
import pytest
from cryptography.fernet import Fernet

from app.config import DEFAULT_GRAPH_BASE_URL, DEFAULT_MICROSOFT_LOGIN_BASE_URL
from app.core.pipeline_constants import OUTREACH_UNSUBSCRIBE_LINE
from app.services import encryption_service, outreach_email_service
from app.services.firestore_service import (
    OutreachEmailsRepo,
    OutreachSendCountersRepo,
    contacts_repo,
    do_not_contact_repo,
    leads_repo,
    mail_connections_repo,
    mail_oauth_states_repo,
    outreach_emails_repo,
    outreach_send_counters_repo,
    pipeline_configs_repo,
)
from app.services.mail_connection_service import MailConnectionService
from app.services.outreach_email_service import OutreachEmailService
from tests.conftest import FAKE_USER_SUB
from tests.fake_firestore import use_fake_firestore
from tests.fake_microsoft import SENT_THEN_500, SENT_THEN_TIMEOUT, FakeMicrosoft

API = "/api/v1/outreach-emails"
USER = FAKE_USER_SUB
OTHER = "someone-else"
T0 = datetime(2026, 11, 12, 15, 0, tzinfo=timezone.utc)
RECIPIENT = "ana.perez@example.test"
ACCESS_TOKEN = "fake-access-token-stored"
REFRESH_TOKEN = "fake-refresh-token-stored"
SENDER = "ventas@example.test"
SENDER_NAME = "Equipo Ventas"
settings = outreach_email_service.settings

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
CONFIG = {"userId": USER, "outreach_real_send_enabled": True, "outreach_daily_send_limit": 50}


def mailbox_doc(**overrides):
    return {
        "user_id": USER, "provider": "microsoft", "address": SENDER, "display_name": SENDER_NAME,
        "account_id": "fake-account-id", "scopes": ["Mail.ReadWrite", "Mail.Send"],
        "access_token_encrypted": encryption_service.encrypt(ACCESS_TOKEN),
        "refresh_token_encrypted": encryption_service.encrypt(REFRESH_TOKEN),
        "access_expires_at": T0 + timedelta(hours=1), "connected_at": T0 - timedelta(days=1),
        "token_version": 1, "needs_reconnect": False, "reconnect_reason": None, **overrides,
    }


class FakeLLM:
    async def __call__(self, prompt, **kwargs):
        return json.dumps({"subject": "Asunto", "body": "Cuerpo"})


class World:
    def __init__(self, db, ms, clock):
        self.db, self.ms, self.clock = db, ms, clock

    def email(self, email_id="e-1"):
        return self.db.doc("outreach_emails", email_id)

    def lead(self):
        return self.db.doc("leads", "lead-1")

    def mailbox(self):
        return self.db.doc("mail_connections", USER)

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


@pytest.fixture
def world(encryption_key, monkeypatch):
    monkeypatch.setattr(settings, "outreach_real_send_enabled", True)
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "mail_oauth_client_id", "00000000-0000-0000-0000-000000000000")
    monkeypatch.setattr(settings, "mail_oauth_client_secret", "fake-client-secret")
    monkeypatch.setattr(settings, "microsoft_login_base_url", DEFAULT_MICROSOFT_LOGIN_BASE_URL)
    monkeypatch.setattr(settings, "graph_base_url", DEFAULT_GRAPH_BASE_URL)
    monkeypatch.setattr(settings, "mail_allow_custom_endpoints", False)
    monkeypatch.setattr(settings, "mail_http_timeout_seconds", 20.0)
    with use_fake_firestore() as db, FakeMicrosoft() as ms:
        db.put("leads", "lead-1", LEAD)
        db.put("contacts", "c-1", CONTACT)
        db.put("outreach_emails", "e-1", EMAIL)
        db.put("pipeline_configs", USER, CONFIG)
        db.put("mail_connections", USER, mailbox_doc())
        now = {"t": T0}
        ids = (f"id-{n}" for n in itertools.count(1))
        mailbox = MailConnectionService(mail_oauth_states_repo, mail_connections_repo, clock=lambda: now["t"])
        service = OutreachEmailService(
            leads_repo, contacts_repo, outreach_emails_repo, FakeLLM(), lambda: now["t"], lambda: next(ids),
            configs=pipeline_configs_repo, do_not_contact=do_not_contact_repo,
            send_counters=outreach_send_counters_repo, mailbox=mailbox,
        )
        with (
            patch("app.services.outreach_email_service.get_service", return_value=service),
            patch("app.middleware.audit.settings.audit_log_enabled", False),
        ):
            yield World(db, ms, now)


async def send(client, email_id="e-1", confirm=RECIPIENT, **body):
    return await client.post(f"{API}/{email_id}/send", json={"confirm_to_email": confirm, **body})


def code_of(resp):
    return resp.json()["detail"]["code"]


def assert_no_token(text: str) -> None:
    for marker in (ACCESS_TOKEN, REFRESH_TOKEN, "fake-access-token", "fake-refresh-token", "fake-client-secret"):
        assert marker not in text, marker


# ── Success ──────────────────────────────────────────────────────────────────
async def test_send_creates_a_draft_sends_it_and_closes_the_email(client, world):
    resp = await send(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "sent" and body["send_method"] == "platform" and body["lead_status"] == "sent"
    assert body["sent_by"] == USER and body["sent_by_name"] == "Test User"
    assert body["send_lock"] is None and body["last_send_error"] is None and body["send_attempts"] == 1
    assert body["sender_address"] == SENDER and body["sender_display_name"] == SENDER_NAME
    assert body["unsubscribe_line"] == OUTREACH_UNSUBSCRIBE_LINE["es"]
    assert_no_token(resp.text)

    [draft_call] = world.ms.drafts_created()
    [send_call] = world.ms.sends()
    assert world.ms.calls.index(draft_call) < world.ms.calls.index(send_call)
    assert len(world.ms.calls) == 2  # no read: the send was accepted
    for call in (draft_call, send_call):
        assert call["headers"]["authorization"] == f"Bearer {ACCESS_TOKEN}"
        assert call["headers"]["prefer"] == 'IdType="ImmutableId"'
    payload = draft_call["json"]
    assert payload["subject"] == EMAIL["subject"]
    assert payload["body"]["contentType"] == "Text"
    assert payload["body"]["content"].rstrip().endswith(OUTREACH_UNSUBSCRIBE_LINE["es"])
    assert payload["body"]["content"].startswith("Hola Ana,")
    assert payload["toRecipients"] == [{"emailAddress": {"address": RECIPIENT}}]
    assert set(payload) == {"subject", "body", "toRecipients"}  # the sender is the mailbox itself

    [message] = world.ms.sent_messages()
    stored = world.email()
    assert stored["status"] == "sent" and stored["send_method"] == "platform" and "send_lock" not in stored
    assert stored["graph_message_id"] == message["id"]
    assert stored["internet_message_id"] == message["internetMessageId"]
    assert stored["conversation_id"] == message["conversationId"]
    assert stored["sender_address"] == SENDER and stored["sender_display_name"] == SENDER_NAME
    last = stored["history"][-1]
    assert last["action"] == "send" and last["to_status"] == "sent"
    assert last["send_method"] == "platform" and last["internet_message_id"] == message["internetMessageId"]
    assert "resolved_by_reading" not in last
    assert world.lead()["status"] == "sent"
    assert world.sent_today() == 1
    assert_no_token(str(world.db.writes_to("outreach_emails")))


async def test_the_draft_id_is_escaped_in_the_send_url(client, world):
    await send(client)
    [send_call] = world.ms.sends()
    assert "/" not in send_call["raw_path"].split("/me/messages/", 1)[1].removesuffix("/send")
    assert "%2F" in send_call["raw_path"] and "%2B" in send_call["raw_path"] and "%3D" in send_call["raw_path"]


async def test_a_subject_with_line_breaks_goes_out_on_one_line(client, world):
    world.db.data["outreach_emails"]["e-1"]["subject"] = "Asunto\r\nBcc: otro@example.test"
    await send(client)
    assert world.ms.drafts_created()[0]["json"]["subject"] == "Asunto Bcc: otro@example.test"


async def test_the_confirmation_ignores_case_and_spaces(client, world):
    assert (await send(client, confirm="  ANA.Perez@Example.TEST ")).status_code == 200


async def test_mark_sent_is_manual_and_still_works(client, world):
    resp = await client.patch(f"{API}/e-1/mark-sent")
    assert resp.status_code == 200
    assert resp.json()["send_method"] == "manual" and world.email()["send_method"] == "manual"
    assert world.ms.calls == []


async def test_an_expiring_token_is_renewed_before_anything_is_reserved(client, world):
    world.db.data["mail_connections"][USER]["access_expires_at"] = T0 + timedelta(seconds=30)
    resp = await send(client)
    assert resp.status_code == 200
    paths = [c["path"] for c in world.ms.calls]
    assert paths[0].endswith("/oauth2/v2.0/token")
    assert world.ms.drafts_created()[0]["headers"]["authorization"] == "Bearer fake-access-token-1"
    assert world.mailbox()["token_version"] == 2


# ── The order of the checks ──────────────────────────────────────────────────
# Each check, from first to last, as (code, how to make it fail). The send
# must stop at the first one that fails, whatever fails after it.
def _pending(world):
    world.db.data["outreach_emails"]["e-1"]["status"] = "pending_review"


def _switch_off(world):
    world.db.data["pipeline_configs"][USER]["outreach_real_send_enabled"] = False


def _no_mailbox(world):
    del world.db.data["mail_connections"][USER]


def _contact_pending(world):
    world.db.data["contacts"]["c-1"]["review_status"] = "pending"


def _contact_moved(world):
    world.db.data["contacts"]["c-1"]["email"] = "nueva@example.test"


def _malformed(world):
    world.db.data["contacts"]["c-1"]["email"] = "no-es-un-correo"
    world.db.data["outreach_emails"]["e-1"]["to_email"] = "no-es-un-correo"


async def _blocked(world):
    for value in (RECIPIENT, "no-es-un-correo"):
        await do_not_contact_repo.add(USER, "email", value, created_by=USER)


def _held(world):
    world.db.data["outreach_emails"]["e-1"]["send_lock"] = {"id": "other-tab", "at": T0, "uncertain": False}


def _quota_used(world):
    world.set_count(50)


ORDER = [
    ("invalid_email_transition", _pending),
    ("real_send_disabled", _switch_off),
    ("mailbox_not_connected", _no_mailbox),
    ("contact_not_approved", _contact_pending),
    ("recipient_changed", _contact_moved),
    ("invalid_recipient", _malformed),
    ("do_not_contact", _blocked),
    ("recipient_mismatch", None),   # a wrong confirmation (passed to send)
    ("send_in_progress", _held),
    ("daily_limit_reached", _quota_used),
]


async def _break(world, fn):
    if fn is None:
        return
    result = fn(world)
    if asyncio.iscoroutine(result):
        await result


@pytest.mark.parametrize("first", range(len(ORDER) - 1), ids=[code for code, _ in ORDER[:-1]])
async def test_the_first_failing_check_wins_over_every_later_one(client, world, first):
    # Break this check and every later one. Later breaks go first, so an
    # earlier break that rewrites the same field (the recipient) prevails.
    for code, fn in reversed(ORDER[first:]):
        await _break(world, fn)
    wrong_confirmation = any(code == "recipient_mismatch" for code, _ in ORDER[first:])
    resp = await send(client, confirm="otra@example.test" if wrong_confirmation else RECIPIENT)
    assert code_of(resp) == ORDER[first][0]
    assert world.ms.calls == []                       # the mail service is never reached
    stored = world.email()
    assert "send_attempts" not in stored and stored.get("send_lock", {}).get("id") in (None, "other-tab")


async def test_the_mail_service_comes_after_every_check(client, world):
    _quota_used(world)
    assert code_of(await send(client)) == "daily_limit_reached"
    assert world.ms.calls == []


# ── Refusals before anything is reserved ─────────────────────────────────────
def assert_nothing_reserved(world):
    stored = world.email()
    assert stored["status"] == "approved" and "send_lock" not in stored and "send_attempts" not in stored
    assert world.sent_today() == 0 and world.ms.drafts_created() == [] and world.ms.sends() == []
    assert world.db.writes_to("outreach_emails") == [] and world.db.writes_to("outreach_send_counters") == []


@pytest.mark.parametrize("status", ["pending_review", "sent", "rejected"])
async def test_only_approved_emails_are_sent(client, world, status):
    world.db.data["outreach_emails"]["e-1"]["status"] = status
    resp = await send(client)
    assert resp.status_code == 422 and code_of(resp) == "invalid_email_transition"
    assert world.ms.calls == [] and world.db.writes == []


@pytest.mark.parametrize("change", [{"review_status": "pending"}, {"review_status": "rejected"}, {"lead_id": "lead-2"}])
async def test_a_contact_not_approved_blocks_the_send(client, world, change):
    world.db.data["contacts"]["c-1"].update(change)
    resp = await send(client)
    assert resp.status_code == 422 and code_of(resp) == "contact_not_approved"
    assert_nothing_reserved(world)


@pytest.mark.parametrize("server, user", [(False, True), (True, False), (False, False)])
async def test_both_switches_are_required(client, world, monkeypatch, server, user):
    monkeypatch.setattr(settings, "outreach_real_send_enabled", server)
    world.db.data["pipeline_configs"][USER]["outreach_real_send_enabled"] = user
    resp = await send(client)
    assert resp.status_code == 403 and code_of(resp) == "real_send_disabled"
    assert_nothing_reserved(world)


async def test_without_a_connected_mailbox(client, world):
    del world.db.data["mail_connections"][USER]
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "mailbox_not_connected"
    assert_nothing_reserved(world)


async def test_someone_elses_mailbox_does_not_count(client, world):
    world.db.data["mail_connections"][USER]["user_id"] = OTHER
    assert code_of(await send(client)) == "mailbox_not_connected"
    assert_nothing_reserved(world)


async def test_a_mailbox_that_needs_reconnecting(client, world):
    world.db.data["mail_connections"][USER]["needs_reconnect"] = True
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "mailbox_reconnect_required"
    assert_nothing_reserved(world)
    assert world.ms.calls == []


async def test_unreadable_tokens_need_reconnecting(client, world):
    world.db.data["mail_connections"][USER]["access_token_encrypted"] = Fernet(Fernet.generate_key()).encrypt(b"x").decode()
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "mailbox_reconnect_required"
    assert world.mailbox()["needs_reconnect"] is True
    assert world.email()["status"] == "approved" and world.sent_today() == 0 and world.ms.calls == []


async def test_without_the_encryption_key(client, world, monkeypatch):
    monkeypatch.setattr(encryption_service.settings, "pipeline_encryption_key", "")
    encryption_service._fernet.cache_clear()
    resp = await send(client)
    assert resp.status_code == 503 and code_of(resp) == "encryption_not_configured"
    assert_nothing_reserved(world)


async def test_a_refused_token_renewal_needs_reconnecting_and_reserves_nothing(client, world):
    world.db.data["mail_connections"][USER]["access_expires_at"] = T0 - timedelta(seconds=1)
    world.ms.token_replies.append((400, {"error": "invalid_grant"}))
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "mailbox_reconnect_required"
    assert world.mailbox()["needs_reconnect"] is True
    assert world.email()["status"] == "approved" and "send_lock" not in world.email() and world.sent_today() == 0
    assert world.ms.drafts_created() == []


async def test_a_throttled_token_renewal_reserves_nothing(client, world):
    world.db.data["mail_connections"][USER]["access_expires_at"] = T0 - timedelta(seconds=1)
    world.ms.token_replies.append((429, {}, {"Retry-After": "9"}))
    resp = await send(client)
    assert resp.status_code == 503 and resp.json()["detail"] == {"code": "mail_throttled", "retry_after": 9}
    assert world.mailbox()["needs_reconnect"] is False
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
    _malformed(world)
    resp = await send(client, confirm="no-es-un-correo")
    assert resp.status_code == 422 and code_of(resp) == "invalid_recipient"
    assert_nothing_reserved(world)


async def test_a_recipient_without_address_is_refused(client, world):
    world.db.data["contacts"]["c-1"]["email"] = ""
    world.db.data["outreach_emails"]["e-1"]["to_email"] = ""
    resp = await send(client, confirm="x")
    assert resp.status_code == 422 and code_of(resp) == "contact_without_email"
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


async def test_someone_elses_or_a_missing_email(client, world):
    assert (await send(client, email_id="nope")).status_code == 404
    world.db.data["outreach_emails"]["e-1"]["user_id"] = OTHER
    assert (await send(client)).status_code == 403
    assert world.ms.calls == []


async def test_the_body_needs_a_confirmation(client, world):
    resp = await client.post(f"{API}/e-1/send", json={})
    assert resp.status_code == 422 and world.ms.calls == []


# ── Daily quota ──────────────────────────────────────────────────────────────
async def test_the_daily_limit_is_enforced(client, world):
    world.db.data["pipeline_configs"][USER]["outreach_daily_send_limit"] = 3
    world.set_count(3)
    resp = await send(client)
    assert resp.status_code == 429 and code_of(resp) == "daily_limit_reached"
    assert world.ms.calls == [] and "send_lock" not in world.email()


async def test_the_quota_starts_over_the_next_day(client, world):
    world.db.data["pipeline_configs"][USER]["outreach_daily_send_limit"] = 1
    world.set_count(1)
    world.clock["t"] = T0 + timedelta(days=1)
    world.db.data["mail_connections"][USER]["access_expires_at"] = T0 + timedelta(days=2)
    assert (await send(client)).status_code == 200
    assert world.sent_today() == 1


async def test_a_stored_limit_above_the_cap_is_capped(client, world):
    world.db.data["pipeline_configs"][USER]["outreach_daily_send_limit"] = 1000
    world.set_count(100)
    assert code_of(await send(client)) == "daily_limit_reached"


# ── Safe failures: nothing was sent ──────────────────────────────────────────
SAFE_FAILURES = [
    ("draft", (400, {"error": {"code": "ErrorInvalidRecipients"}}), 502, "mail_rejected"),
    ("draft", (403, {"error": {"code": "ErrorAccessDenied"}}), 409, "missing_permissions"),
    ("draft", (429, {}, {"Retry-After": "5"}), 503, "mail_throttled"),
    ("draft", (503, {}), 502, "mail_service_unavailable"),
    ("draft", httpx.ReadTimeout("t"), 504, "mail_service_timeout"),
    ("draft", httpx.ConnectError("c"), 502, "mail_service_unavailable"),
    ("send", (400, {"error": {"code": "ErrorMessageSizeExceeded"}}), 502, "mail_rejected"),
    ("send", (403, {}), 409, "missing_permissions"),
    ("send", (429, {}), 503, "mail_throttled"),
    ("send", httpx.ConnectError("c"), 502, "mail_service_unavailable"),
    ("send", httpx.ConnectTimeout("c"), 504, "mail_service_timeout"),
]


@pytest.mark.parametrize("stage, failure, status, code", SAFE_FAILURES)
async def test_a_failure_before_the_send_was_accepted_frees_the_lock_and_the_quota(client, world, stage, failure, status, code):
    world.ms.next[stage].append(failure)
    resp = await send(client)
    assert resp.status_code == status and code_of(resp) == code
    stored = world.email()
    assert stored["status"] == "approved" and "send_lock" not in stored
    assert stored["last_send_error"]["code"] == code and stored["send_attempts"] == 1
    assert world.sent_today() == 0
    assert world.lead()["status"] == "approved"
    assert world.ms.sent_messages() == []

    again = await send(client)  # a retry is allowed right away
    assert again.status_code == 200 and "last_send_error" not in world.email()
    assert world.sent_today() == 1 and len(world.ms.sent_messages()) == 1
    # A draft made by the failed attempt is reused, not duplicated.
    assert len(world.ms.messages) == 1


@pytest.mark.parametrize("stage", ["draft", "send"])
async def test_a_refused_token_during_the_send_needs_reconnecting(client, world, stage):
    world.ms.next[stage].append((401, {"error": {"code": "InvalidAuthenticationToken"}}))
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "mailbox_reconnect_required"
    assert world.mailbox()["needs_reconnect"] is True and world.mailbox()["reconnect_reason"] == "send_refused"
    stored = world.email()
    assert stored["status"] == "approved" and "send_lock" not in stored and world.sent_today() == 0
    # Until the user connects again, nothing reaches the mail service.
    calls = len(world.ms.calls)
    assert code_of(await send(client)) == "mailbox_reconnect_required"
    assert len(world.ms.calls) == calls


async def test_a_retry_after_a_refused_send_reuses_the_draft(client, world):
    world.ms.next["send"].append((400, {}))  # refused: safe, the draft stays
    await send(client)
    first_draft = world.email()["graph_message_id"]
    assert first_draft
    resp = await send(client)
    assert resp.status_code == 200
    assert len(world.ms.drafts_created()) == 1 and world.email()["graph_message_id"] == first_draft
    assert len(world.ms.reads()) == 1  # the draft was read before sending it again


# ── Uncertain sends ──────────────────────────────────────────────────────────
@pytest.mark.parametrize("failure", [httpx.ReadTimeout("t"), httpx.RemoteProtocolError("dropped"), (500, {}), (504, {})])
async def test_a_send_without_answer_that_did_not_go_out_is_uncertain(client, world, failure):
    world.ms.next["send"].append(failure)
    resp = await send(client)
    assert resp.status_code == 504 and code_of(resp) == "send_timeout"
    stored = world.email()
    assert stored["status"] == "approved" and stored["send_lock"]["uncertain"] is True
    assert stored["last_send_error"]["code"] == "send_timeout"
    assert world.sent_today() == 1  # the uncertain attempt keeps its slot
    assert world.lead()["status"] == "approved"
    assert len(world.ms.reads()) == 1  # it was read once, and is still a draft

    plain = await send(client)
    assert plain.status_code == 409 and code_of(plain) == "send_uncertain"
    assert len(world.ms.sends()) == 1


@pytest.mark.parametrize("planned", [SENT_THEN_TIMEOUT, SENT_THEN_500])
async def test_a_send_without_answer_that_did_go_out_is_a_success(client, world, planned):
    world.ms.next["send"].append(planned)
    resp = await send(client)
    assert resp.status_code == 200 and resp.json()["status"] == "sent"
    assert len(world.ms.sends()) == 1 and len(world.ms.reads()) == 1
    assert "send_lock" not in world.email() and world.sent_today() == 1


async def test_an_uncertain_send_whose_message_cannot_be_read_stays_uncertain(client, world):
    world.ms.next["send"].append(SENT_THEN_TIMEOUT)
    world.ms.next["read"].append(httpx.ReadTimeout("t"))
    resp = await send(client)
    assert code_of(resp) == "send_timeout"
    assert world.email()["send_lock"]["uncertain"] is True and world.sent_today() == 1


async def test_a_forced_retry_of_a_send_that_went_out_does_not_send_it_again(client, world):
    world.ms.next["send"].append(SENT_THEN_TIMEOUT)
    world.ms.next["read"].append(httpx.ReadTimeout("t"))
    await send(client)
    assert world.email()["send_lock"]["uncertain"] is True

    resp = await send(client, force_retry=True)
    assert resp.status_code == 200 and resp.json()["status"] == "sent"
    assert len(world.ms.sends()) == 1                         # not sent twice
    assert len(world.ms.sent_messages()) == 1
    stored = world.email()
    assert stored["history"][-1]["resolved_by_reading"] is True
    assert stored["send_attempts"] == 2
    assert world.sent_today() == 1                            # this attempt's slot was given back


async def test_a_forced_retry_of_a_send_still_in_drafts_sends_the_same_draft(client, world):
    world.ms.next["send"].append(httpx.ReadTimeout("t"))
    await send(client)
    draft_id = world.email()["graph_message_id"]
    resp = await send(client, force_retry=True)
    assert resp.status_code == 200
    assert len(world.ms.drafts_created()) == 1 and len(world.ms.sends()) == 2
    assert [s["path"] for s in world.ms.sends()][0] == [s["path"] for s in world.ms.sends()][1]
    assert world.email()["graph_message_id"] == draft_id
    assert world.email()["send_attempts"] == 2 and world.sent_today() == 2


async def test_a_forced_retry_whose_draft_was_deleted_creates_a_new_one(client, world):
    world.ms.next["send"].append(httpx.ReadTimeout("t"))
    await send(client)
    world.ms.messages.clear()  # the user deleted the draft
    resp = await send(client, force_retry=True)
    assert resp.status_code == 200
    assert len(world.ms.drafts_created()) == 2 and len(world.ms.sent_messages()) == 1


async def test_a_forced_retry_that_cannot_read_the_message_stays_uncertain_and_gives_its_slot_back(client, world):
    world.ms.next["send"].append(httpx.ReadTimeout("t"))
    await send(client)
    assert world.sent_today() == 1
    world.ms.next["read"].append(httpx.ReadTimeout("t"))
    resp = await send(client, force_retry=True)
    assert resp.status_code == 504 and code_of(resp) == "mail_service_timeout"
    stored = world.email()
    assert stored["send_lock"]["uncertain"] is True and stored["status"] == "approved"
    assert world.sent_today() == 1 and len(world.ms.sends()) == 1


async def test_force_retry_without_an_uncertain_lock_is_ignored(client, world):
    resp = await send(client, force_retry=True)
    assert resp.status_code == 200 and len(world.ms.sends()) == 1


async def test_an_unexpected_delivery_failure_is_treated_as_uncertain(client, world, monkeypatch):
    async def boom(*args, **kwargs):
        raise RuntimeError("fake-access-token-in-a-message")
    monkeypatch.setattr(outreach_email_service.graph_client, "send_draft", boom)
    resp = await send(client)
    assert resp.status_code == 504 and code_of(resp) == "send_timeout"
    assert world.email()["send_lock"]["uncertain"] is True
    assert_no_token(resp.text)


async def test_logs_never_carry_a_token_or_the_recipient(client, world, caplog):
    world.ms.next["draft"].append((400, {"error": {"code": "ErrorInvalidRecipients", "message": RECIPIENT}}))
    with caplog.at_level(logging.DEBUG):
        await send(client)                         # refused
        world.ms.next["send"].append(httpx.ReadTimeout("t"))
        await send(client)                         # uncertain
        await send(client, force_retry=True)       # resolved
    text = caplog.text
    assert_no_token(text)
    assert RECIPIENT not in text and SENDER not in text


# ── Send lock ────────────────────────────────────────────────────────────────
async def _while_sending(world, client, request):
    """Start a send, wait until it is inside the mail service's send, run
    `request` (another tab) meanwhile, then let the send finish."""
    world.ms.send_gate = asyncio.Event()
    first = asyncio.create_task(send(client))
    for _ in range(200):
        if world.ms.sends():
            break
        await asyncio.sleep(0.01)
    assert len(world.ms.sends()) == 1
    other = await request()
    world.ms.send_gate.set()
    return await first, other


async def test_two_sends_at_once_send_only_once(client, world):
    first, second = await _while_sending(world, client, lambda: send(client))
    assert first.status_code == 200
    assert second.status_code == 409 and code_of(second) == "send_in_progress"
    assert len(world.ms.sends()) == 1 and len(world.ms.drafts_created()) == 1 and world.sent_today() == 1


@pytest.mark.parametrize("action", ["mark-sent", "reject"])
async def test_marking_while_another_tab_sends_is_refused(client, world, action):
    first, other = await _while_sending(world, client, lambda: client.patch(f"{API}/e-1/{action}"))
    assert other.status_code == 409 and code_of(other) == "send_in_progress"
    assert first.status_code == 200 and world.email()["send_method"] == "platform"


def held_lock(world, age_seconds=5, uncertain=False):
    world.db.data["outreach_emails"]["e-1"]["send_lock"] = {
        "id": "other-tab", "at": T0 - timedelta(seconds=age_seconds), "uncertain": uncertain,
    }


def test_a_lock_goes_stale_after_twice_the_longest_send():
    # 3 calls (draft, send, read) × 20 s × 2
    assert OutreachEmailsRepo.send_lock_stale_after() == timedelta(seconds=120)


async def test_a_held_lock_refuses_a_send(client, world):
    held_lock(world)
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "send_in_progress"
    assert world.ms.calls == [] and world.sent_today() == 0


async def test_a_lock_younger_than_the_limit_is_still_held(client, world):
    held_lock(world, age_seconds=119)
    assert code_of(await send(client)) == "send_in_progress"


async def test_a_stale_lock_is_replaced(client, world):
    held_lock(world, age_seconds=121)
    assert (await send(client)).status_code == 200


@pytest.mark.parametrize("action", ["mark-sent", "reject"])
async def test_a_held_lock_refuses_mark_sent_and_reject(client, world, action):
    held_lock(world)
    resp = await client.patch(f"{API}/e-1/{action}")
    assert resp.status_code == 409 and code_of(resp) == "send_in_progress"
    stored = world.email()
    assert stored["status"] == "approved" and stored["send_lock"]["id"] == "other-tab"
    assert world.lead()["status"] == "approved"


async def test_mark_sent_after_an_uncertain_send_frees_the_lock(client, world):
    world.ms.next["send"].append(httpx.ReadTimeout("t"))
    await send(client)
    resp = await client.patch(f"{API}/e-1/mark-sent")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "sent" and body["send_method"] == "manual" and body["send_lock"] is None
    assert body["lead_status"] == "sent"
    stored = world.email()
    assert "send_lock" not in stored and stored["history"][-1]["send_error"] == "send_timeout"


async def test_reject_after_an_uncertain_send_frees_the_lock(client, world):
    world.ms.next["send"].append(httpx.ReadTimeout("t"))
    await send(client)
    resp = await client.patch(f"{API}/e-1/reject")
    assert resp.status_code == 200 and resp.json()["status"] == "rejected"
    assert "send_lock" not in world.email()


async def test_mark_sent_clears_a_stale_lock(client, world):
    held_lock(world, age_seconds=600)
    resp = await client.patch(f"{API}/e-1/mark-sent")
    assert resp.status_code == 200 and "send_lock" not in world.email()


# ── Send status ──────────────────────────────────────────────────────────────
async def test_send_status_with_a_connected_mailbox(client, world):
    world.set_count(2)
    resp = await client.get(f"{API}/send-status")
    assert resp.status_code == 200
    assert resp.json() == {
        "oauth_configured": True, "mailbox_connected": True, "mailbox_needs_reconnect": False,
        "mailbox_address": SENDER, "server_send_enabled": True, "user_send_enabled": True,
        "real_send_enabled": True, "daily_limit": 50, "sent_today": 2,
        "sender_email": SENDER, "sender_name": SENDER_NAME,
    }
    assert_no_token(resp.text)
    assert world.ms.calls == []  # reading the status never calls Microsoft


async def test_send_status_without_a_mailbox(client, world, monkeypatch):
    monkeypatch.setattr(settings, "outreach_real_send_enabled", False)
    del world.db.data["mail_connections"][USER]
    body = (await client.get(f"{API}/send-status")).json()
    assert body["mailbox_connected"] is False and body["mailbox_address"] is None
    assert body["sender_email"] == "" and body["sender_name"] == ""
    assert body["server_send_enabled"] is False and body["real_send_enabled"] is False


async def test_send_status_of_a_mailbox_that_needs_reconnecting(client, world):
    world.db.data["mail_connections"][USER]["needs_reconnect"] = True
    body = (await client.get(f"{API}/send-status")).json()
    assert body["mailbox_connected"] is True and body["mailbox_needs_reconnect"] is True


async def test_send_status_without_an_app_registration(client, world, monkeypatch):
    monkeypatch.setattr(settings, "mail_oauth_client_secret", "")
    assert (await client.get(f"{API}/send-status")).json()["oauth_configured"] is False


async def test_send_status_without_a_config(client, world):
    del world.db.data["pipeline_configs"][USER]
    body = (await client.get(f"{API}/send-status")).json()
    assert body["user_send_enabled"] is False and body["daily_limit"] == 50
    assert not any("smtp" in key for key in body)


# ── Unsubscribe line in every response ───────────────────────────────────────
@pytest.mark.parametrize("language", ["en", "es", "pt", None])
async def test_every_email_shows_its_unsubscribe_line(client, world, language):
    world.db.data["outreach_emails"]["e-1"]["language"] = language
    expected = OUTREACH_UNSUBSCRIBE_LINE[language or "en"]
    assert (await client.get(f"{API}/e-1")).json()["unsubscribe_line"] == expected
    assert (await client.get(API)).json()["items"][0]["unsubscribe_line"] == expected


@pytest.mark.parametrize("language", ["en", "pt"])
async def test_the_unsubscribe_line_goes_out_in_the_emails_language(client, world, language):
    world.db.data["outreach_emails"]["e-1"]["language"] = language
    await send(client)
    content = world.ms.drafts_created()[0]["json"]["body"]["content"]
    assert content.rstrip().endswith(OUTREACH_UNSUBSCRIBE_LINE[language])


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
    monkeypatch.setattr(settings, "app_env", "production")
    resp = await send(client)
    assert resp.status_code == 422 and code_of(resp) == "invalid_recipient"
    assert_nothing_reserved(world)


async def test_a_test_domain_recipient_is_accepted_outside_production(client, world, monkeypatch):
    monkeypatch.setattr(settings, "app_env", "test")
    assert (await send(client)).status_code == 200


async def test_a_test_domain_do_not_contact_entry_is_refused_in_production(client, world, monkeypatch):
    monkeypatch.setattr(settings, "app_env", "production")
    resp = await client.post(f"{API}/do-not-contact", json={"email": "x@example.test"})
    assert resp.status_code == 422 and code_of(resp) == "invalid_do_not_contact"
    monkeypatch.setattr(settings, "app_env", "development")
    assert (await client.post(f"{API}/do-not-contact", json={"email": "x@example.test"})).status_code == 201
