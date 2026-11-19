"""Sending from Gmail (RF-VTA-16): users who sign in with Google can connect their own Gmail mailbox, next to
Outlook. Covers gmail_client (wire format, errors), the connection flow (start / GET callback / status / test /
refresh), and a real send through OutreachEmailService with a Gmail mailbox.

Google is faked in-process (tests/fake_google.py), Firestore in memory (tests/fake_firestore.py): no network.
Synthetic data only; every token starts with "fake-"."""
from __future__ import annotations

import itertools
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from cryptography.fernet import Fernet

from app.config import DEFAULT_GRAPH_BASE_URL, DEFAULT_MICROSOFT_LOGIN_BASE_URL
from app.core.pipeline_constants import MAIL_GOOGLE_SCOPES, OUTREACH_UNSUBSCRIBE_LINE
from app.services import encryption_service, gmail_client, graph_client, mail_connection_service, mail_providers
from app.services.firestore_service import (
    MailOAuthStatesRepo,
    contacts_repo,
    do_not_contact_repo,
    leads_repo,
    mail_connections_repo,
    mail_oauth_states_repo,
    outreach_emails_repo,
    outreach_send_counters_repo,
    pipeline_configs_repo,
)
from app.services.gmail_client import GraphError
from app.services.mail_connection_service import MailConnectionService
from app.services.outreach_email_service import OutreachEmailService
from tests.conftest import FAKE_USER_EMAIL, FAKE_USER_SUB
from tests.fake_firestore import use_fake_firestore
from tests.fake_google import SENT_THEN_500, SENT_THEN_TIMEOUT, FakeGoogle, decode_raw
from tests.fake_microsoft import FakeMicrosoft
from tests.test_outreach_emails_send import (
    CONFIG,
    CONTACT,
    EMAIL,
    LEAD,
    RECIPIENT,
    T0,
    FakeLLM,
    code_of,
    mailbox_doc,
)

API = "/api/v1/mail-connection"
SEND_API = "/api/v1/outreach-emails"
USER = FAKE_USER_SUB
FRONTEND = "http://frontend.example.test"
CLIENT_ID = "fake-google-client.apps.googleusercontent.com"
REDIRECT = "http://127.0.0.1:8000/api/v1/mail-connection/google/callback"
SECRETS = ("fake-access-token", "fake-refresh-token", "fake-auth-code", "fake-google-secret")


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    s = gmail_client.settings
    monkeypatch.setattr(s, "app_env", "development")
    monkeypatch.setattr(s, "google_oauth_client_id", CLIENT_ID)
    monkeypatch.setattr(s, "google_oauth_client_secret", "fake-google-secret")
    monkeypatch.setattr(s, "mail_google_redirect_url", REDIRECT)
    monkeypatch.setattr(s, "mail_http_timeout_seconds", 20.0)
    monkeypatch.setattr(s, "frontend_url", FRONTEND)
    monkeypatch.delenv("VERCEL_PROJECT_PRODUCTION_URL", raising=False)
    # Outlook is configured too, to check that choosing a provider really chooses.
    monkeypatch.setattr(s, "mail_oauth_client_id", "00000000-0000-0000-0000-000000000000")
    monkeypatch.setattr(s, "mail_oauth_client_secret", "fake-client-secret")
    monkeypatch.setattr(s, "microsoft_login_base_url", DEFAULT_MICROSOFT_LOGIN_BASE_URL)
    monkeypatch.setattr(s, "graph_base_url", DEFAULT_GRAPH_BASE_URL)
    monkeypatch.setattr(s, "mail_allow_custom_endpoints", False)
    monkeypatch.setattr(s, "pipeline_encryption_key", Fernet.generate_key().decode())
    encryption_service._fernet.cache_clear()
    yield
    encryption_service._fernet.cache_clear()


@pytest.fixture
def g():
    with FakeGoogle() as fake:
        yield fake


@pytest.fixture
def db():
    with use_fake_firestore() as fake:
        yield fake


def query_of(url: str) -> dict:
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


def assert_no_secrets(text: str) -> None:
    for marker in SECRETS:
        assert marker not in text, marker


# ══ gmail_client ═════════════════════════════════════════════════════════════
def test_authorize_url_asks_for_gmail_compose_offline_with_pkce():
    verifier = gmail_client.new_code_verifier()
    url = gmail_client.authorize_url("the-state", gmail_client.code_challenge(verifier))
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    q = query_of(url)
    assert q["client_id"] == CLIENT_ID and q["redirect_uri"] == REDIRECT and q["response_type"] == "code"
    assert q["state"] == "the-state" and q["code_challenge_method"] == "S256"
    assert q["code_challenge"] == gmail_client.code_challenge(verifier)
    assert q["access_type"] == "offline" and "consent" in q["prompt"]
    assert "https://www.googleapis.com/auth/gmail.compose" in q["scope"].split()
    # It never asks to read the mailbox.
    assert not any(s.endswith(("gmail.readonly", "gmail.modify", "mail.google.com/")) for s in q["scope"].split())
    assert "login_hint" not in q


def test_login_hint_preselects_the_account_but_only_when_it_is_an_address():
    assert query_of(gmail_client.authorize_url("s", "c", login_hint="ana@example.test"))["login_hint"] == "ana@example.test"
    assert "login_hint" not in query_of(gmail_client.authorize_url("s", "c", login_hint="not-an-address"))


async def test_exchange_code_sends_the_verifier_and_reads_the_granted_scopes(g):
    tokens = await gmail_client.exchange_code("fake-auth-code", "the-verifier")
    [call] = g.calls_to("/token")
    assert call["host"] == "oauth2.googleapis.com"
    assert call["form"] == {
        "client_id": CLIENT_ID, "client_secret": "fake-google-secret", "grant_type": "authorization_code",
        "code": "fake-auth-code", "redirect_uri": REDIRECT, "code_verifier": "the-verifier",
    }
    assert tokens.access_token == "fake-access-token-1" and tokens.refresh_token == "fake-refresh-token-1"
    assert "gmail.compose" in tokens.scopes
    assert "fake-access-token" not in repr(tokens)


async def test_refresh_keeps_the_refresh_token_because_google_does_not_rotate_it(g):
    g.token_replies.append((200, g.success(with_refresh=False)))
    tokens = await gmail_client.refresh("fake-refresh-token-old")
    assert tokens.refresh_token == "fake-refresh-token-old" and tokens.access_token.startswith("fake-access-token")
    assert g.calls_to("/token")[0]["form"]["grant_type"] == "refresh_token"


@pytest.mark.parametrize("error", ["invalid_grant", "interaction_required"])
async def test_a_refused_refresh_token_means_reconnect(g, error):
    g.token_replies.append((400, {"error": error, "error_description": "Token has been expired or revoked."}))
    with pytest.raises(GraphError) as exc:
        await gmail_client.refresh("fake-refresh-token-old")
    assert (exc.value.status_code, exc.value.code) == (409, "mailbox_reconnect_required")
    assert "expired" not in str(exc.value.detail)  # Google's text never travels


async def test_get_me_reads_the_google_account(g):
    me = await gmail_client.get_me("fake-access-token-1")
    assert me == {"id": "fake-google-sub", "address": "ventas@example.test", "display_name": "Equipo Ventas"}
    [call] = g.calls
    assert call["headers"]["authorization"] == "Bearer fake-access-token-1"


@pytest.mark.parametrize("reply, status, code", [
    ((401, {}), 409, "mailbox_reconnect_required"),
    ((403, {}), 409, "missing_permissions"),
    ((200, {"sub": "x"}), 422, "mailbox_without_address"),
    ((500, {}), 502, "mail_service_unavailable"),
    ((429, {}), 503, "mail_throttled"),
])
async def test_get_me_failures_are_codes(g, reply, status, code):
    g.userinfo = reply
    with pytest.raises(GraphError) as exc:
        await gmail_client.get_me("fake-access-token-1")
    assert (exc.value.status_code, exc.value.code) == (status, code)


async def test_the_draft_is_a_utf8_plain_text_email_to_one_recipient(g):
    ids = await gmail_client.create_draft(
        "fake-access-token-1", "Vacante de Jefa de Operaciones\r\nBcc: otro@example.test",
        "Hola Ana,\n\nÁrea de operaciones: ñandú, acción.\n", "ana@example.test",
    )
    [call] = g.drafts_created()
    assert call["headers"]["authorization"] == "Bearer fake-access-token-1"
    assert set(call["json"]) == {"message"} and set(call["json"]["message"]) == {"raw"}
    mail = decode_raw(call["json"]["message"]["raw"])
    assert mail["To"] == "ana@example.test"
    assert mail["Subject"] == "Vacante de Jefa de Operaciones Bcc: otro@example.test"  # one line: no header injection
    assert mail["Bcc"] is None and mail["Cc"] is None
    assert mail.get_content_type() == "multipart/alternative"
    plain = mail.get_body(preferencelist=("plain",))
    assert plain.get_content_type() == "text/plain" and plain.get_content_charset() == "utf-8"
    assert "Área de operaciones: ñandú, acción." in plain.get_content()
    assert "Área de operaciones: ñandú, acción." in mail.get_body(preferencelist=("html",)).get_content()
    assert ids["id"].startswith("r-fake") and ids["conversation_id"] == "fake-thread-1"
    assert ids["internet_message_id"] == mail["Message-ID"]


def test_html_body_has_real_paragraphs_and_no_hard_wrapped_lines():
    long_paragraph = "Vi que Empresa Demo está buscando un perfil exigente " * 8      # ~400 caracteres en una sola línea
    html = gmail_client.html_body(f"Hola Ana:\n\n{long_paragraph}\n\nSaludos,\nEquipo NoonDalton\n")
    assert html.count("<p ") == 3
    assert long_paragraph.strip() in html                      # el párrafo largo viaja entero, sin cortes
    assert "Saludos,<br>\nEquipo NoonDalton" in html           # un salto simple dentro de un párrafo = <br>
    assert "=\n" not in html                                   # sin saltos blandos de quoted-printable


def test_html_body_escapes_what_the_model_wrote():
    html = gmail_client.html_body('Hola <script>alert(1)</script> & "amigos"\n\n<b>x</b>')
    assert "<script>" not in html and "<b>" not in html
    assert "&lt;script&gt;" in html and "&amp;" in html and "&lt;b&gt;x&lt;/b&gt;" in html


def test_html_body_of_an_empty_text_is_an_empty_container():
    assert "<p" not in gmail_client.html_body("") and "<p" not in gmail_client.html_body(None)


async def test_the_message_carries_the_html_part_and_the_long_paragraph_whole(g):
    long_paragraph = "Esta oración larga no debe quedar cortada en el correo. " * 10
    await gmail_client.create_draft("t", "Asunto", f"Hola:\n\n{long_paragraph}\n", "ana@example.test")
    mail = decode_raw(g.drafts_created()[0]["json"]["message"]["raw"])
    assert mail.get_content_type() == "multipart/alternative"
    assert [part.get_content_type() for part in mail.iter_parts()] == ["text/plain", "text/html"]
    html = mail.get_body(preferencelist=("html",)).get_content()
    assert long_paragraph.strip() in html and html.count("<p ") == 2
    # Decoded, the plain part keeps the paragraph as ONE line too (the 76-column breaks are only transport encoding).
    plain_lines = mail.get_body(preferencelist=("plain",)).get_content().splitlines()
    assert any(len(line) > 400 for line in plain_lines)


async def test_sending_the_draft_escapes_nothing_in_the_body_and_reads_nothing(g):
    ids = await gmail_client.create_draft("t", "Subject", "Body", "ana@example.test")
    await gmail_client.send_draft("fake-access-token-1", ids["id"])
    [send] = g.sends()
    assert send["json"] == {"id": ids["id"]}
    assert len(g.sent) == 1 and g.reads() == []


async def test_the_draft_id_is_escaped_in_the_url_when_it_is_read(g):
    ids = await gmail_client.create_draft("t", "s", "b", "ana@example.test")
    state = await gmail_client.get_message_state("fake-access-token-1", ids["id"])
    assert state == {"is_draft": True, "internet_message_id": "", "conversation_id": "fake-thread-1"}
    [read] = g.reads()
    assert "/" not in read["raw_path"].split("/drafts/", 1)[1] and "%2F" in read["raw_path"]
    assert read["params"] == {"format": "minimal"}


async def test_a_sent_draft_is_gone_and_gmail_cannot_say_if_it_was_sent_or_deleted(g):
    ids = await gmail_client.create_draft("t", "s", "b", "ana@example.test")
    await gmail_client.send_draft("fake-access-token-1", ids["id"])
    assert await gmail_client.get_message_state("fake-access-token-1", ids["id"]) is None


@pytest.mark.parametrize("operation, planned, status, code, uncertain", [
    ("send", (401, {}), 409, "mailbox_reconnect_required", False),
    ("send", (403, {"error": {"errors": [{"reason": "insufficientPermissions"}]}}), 409, "missing_permissions", False),
    ("send", (403, {"error": {"errors": [{"reason": "rateLimitExceeded"}]}}), 503, "mail_throttled", False),
    ("send", (403, {"error": {"errors": [{"reason": "userRateLimitExceeded"}]}}), 503, "mail_throttled", False),
    ("send", (403, {"error": {"errors": [{"reason": "accessNotConfigured"}]}}), 502, "mail_service_unavailable", False),
    ("send", (429, {}, {"Retry-After": "30"}), 503, "mail_throttled", False),
    ("send", (400, {"error": {"errors": [{"reason": "invalidArgument"}]}}), 502, "mail_rejected", False),
    ("send", (404, {}), 502, "mail_rejected", False),
    ("send", (500, {}), 504, "send_timeout", True),
    ("send", (503, {}), 504, "send_timeout", True),
    ("draft", (401, {}), 409, "mailbox_reconnect_required", False),
    ("draft", (403, {}), 409, "missing_permissions", False),
    ("draft", (500, {}), 502, "mail_service_unavailable", False),
    ("draft", (413, {}), 502, "mail_rejected", False),
])
async def test_gmail_refusals_are_codes_and_only_a_failed_send_can_be_uncertain(
        g, operation, planned, status, code, uncertain):
    ids = {"id": "r-x"}
    g.drafts["r-x"] = {"raw": "", "message": {"id": "m", "threadId": "t"}}
    g.next[operation].append(planned)
    with pytest.raises(GraphError) as exc:
        if operation == "send":
            await gmail_client.send_draft("fake-access-token-1", ids["id"])
        else:
            await gmail_client.create_draft("fake-access-token-1", "s", "b", "ana@example.test")
    assert (exc.value.status_code, exc.value.code, exc.value.uncertain) == (status, code, uncertain)
    assert g.sent == []  # a refusal sent nothing
    if planned[0] == 429:
        assert exc.value.extra == {"retry_after": 30}


async def test_a_timeout_after_connecting_may_have_sent_but_not_connecting_never_did(g):
    g.drafts["r-x"] = {"raw": "", "message": {"id": "m", "threadId": "t"}}
    g.next["send"].append(httpx.ReadTimeout("t"))
    with pytest.raises(GraphError) as exc:
        await gmail_client.send_draft("fake-access-token-1", "r-x")
    assert (exc.value.code, exc.value.uncertain) == ("send_timeout", True)
    g.next["send"].append(httpx.ConnectError("down"))
    with pytest.raises(GraphError) as exc:
        await gmail_client.send_draft("fake-access-token-1", "r-x")
    assert (exc.value.code, exc.value.uncertain) == ("mail_service_unavailable", False)


# ══ providers registry ═══════════════════════════════════════════════════════
def test_the_registry_picks_the_client_and_defaults_to_microsoft_for_old_connections():
    assert mail_providers.client("google") is gmail_client
    assert mail_providers.client("microsoft") is graph_client
    assert mail_providers.client(None) is graph_client and mail_providers.client("") is graph_client
    assert mail_providers.client(" Google ") is gmail_client
    with pytest.raises(ValueError):
        mail_providers.client("yahoo")
    assert mail_providers.configured() == {"microsoft": True, "google": True}


# ══ connection flow ══════════════════════════════════════════════════════════
async def start(client, provider="google") -> dict:
    resp = await client.post(f"{API}/start", json={"provider": provider})
    assert resp.status_code == 200, resp.text
    return query_of(resp.json()["authorize_url"])


async def callback(client, **query):
    return await client.get(f"{API}/google/callback", params=query)


async def connect(client) -> dict:
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.status_code == 303 and resp.headers["location"] == f"{FRONTEND}/?mail_connection=connected", resp.headers
    return params


def stored(db) -> dict:
    return db.doc("mail_connections", USER)


async def test_start_google_sends_the_browser_to_google_with_the_users_address_as_hint(client, db):
    resp = await client.post(f"{API}/start", json={"provider": "google"})
    url = resp.json()["authorize_url"]
    assert url.startswith("https://accounts.google.com/")
    q = query_of(url)
    assert q["login_hint"] == FAKE_USER_EMAIL and "response_mode" not in q
    [(_, doc_id, data)] = db.writes_to("mail_oauth_states")
    assert data["provider"] == "google" and data["user_id"] == USER
    assert doc_id == MailOAuthStatesRepo.doc_id_for(q["state"]) and q["state"] not in doc_id
    verifier = encryption_service.decrypt(data["code_verifier_encrypted"])
    assert q["code_challenge"] == gmail_client.code_challenge(verifier)


async def test_start_without_a_body_is_still_outlook(client, db):
    resp = await client.post(f"{API}/start")
    assert resp.status_code == 200
    assert resp.json()["authorize_url"].startswith("https://login.microsoftonline.com/")
    assert db.writes_to("mail_oauth_states")[0][2]["provider"] == "microsoft"


async def test_start_refuses_an_unknown_provider(client, db):
    assert (await client.post(f"{API}/start", json={"provider": "yahoo"})).status_code == 422
    assert db.writes_to("mail_oauth_states") == []


async def test_start_google_is_refused_when_the_google_client_is_not_configured(client, db, monkeypatch):
    monkeypatch.setattr(gmail_client.settings, "google_oauth_client_secret", "")
    resp = await client.post(f"{API}/start", json={"provider": "google"})
    assert resp.status_code == 503 and resp.json()["detail"]["code"] == "mail_oauth_not_configured"
    assert (await client.post(f"{API}/start", json={"provider": "microsoft"})).status_code == 200  # Outlook unaffected


async def test_a_good_google_callback_stores_the_gmail_mailbox_with_encrypted_tokens(client, db, g):
    await connect(client)
    conn = stored(db)
    assert conn["provider"] == "google" and conn["address"] == "ventas@example.test"
    assert conn["display_name"] == "Equipo Ventas" and conn["account_id"] == "fake-google-sub"
    assert "gmail.compose" in conn["scopes"]
    assert encryption_service.decrypt(conn["access_token_encrypted"]) == "fake-access-token-1"
    assert encryption_service.decrypt(conn["refresh_token_encrypted"]) == "fake-refresh-token-1"
    assert "fake-access-token" not in str({k: v for k, v in conn.items() if not k.endswith("_encrypted")})
    assert conn["needs_reconnect"] is False and conn["token_version"] == 1
    assert all(c["host"] != "login.microsoftonline.com" for c in g.calls)


async def test_the_google_callback_redirects_without_caching_and_without_secrets(client, db, g):
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.headers["cache-control"] == "no-store"
    assert_no_secrets(resp.headers["location"] + resp.text)


async def test_unticking_the_gmail_permission_is_refused_with_missing_permissions(client, db, g):
    g.granted_scopes = "openid email profile"        # Google lets the user untick the Gmail checkbox
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error=missing_permissions"
    assert stored(db) is None


async def test_no_refresh_token_is_refused_because_it_would_stop_working_in_an_hour(client, db, g):
    g.token_replies.append((200, g.success(with_refresh=False)))
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.headers["location"].endswith("mail_connection_error=missing_permissions")
    assert stored(db) is None


@pytest.mark.parametrize("error, code", [("access_denied", "consent_denied"), ("server_error", "authorization_failed")])
async def test_a_google_error_is_reported_by_code_and_consumes_the_state(client, db, g, error, code):
    params = await start(client)
    resp = await callback(client, state=params["state"], error=error, error_description="user text we never show")
    assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error={code}"
    assert "user+text" not in resp.headers["location"] and g.calls == [] and stored(db) is None
    again = await callback(client, state=params["state"], code="fake-auth-code")
    assert again.headers["location"].endswith("mail_connection_error=invalid_state")


async def test_the_google_callback_needs_a_valid_single_use_state(client, db, g):
    assert (await callback(client, code="fake-auth-code")).headers["location"].endswith("=invalid_state")
    assert (await callback(client, state="made-up", code="fake-auth-code")).headers["location"].endswith("=invalid_state")
    params = await start(client)
    assert (await callback(client, state=params["state"], code="fake-auth-code")).headers["location"].endswith("=connected")
    assert (await callback(client, state=params["state"], code="fake-auth-code")).headers["location"].endswith("=invalid_state")
    assert len(g.calls_to("/token")) == 1


async def test_a_refused_code_is_a_failed_authorization(client, db, g):
    g.token_replies.append((400, {"error": "invalid_grant"}))
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.headers["location"].endswith("mail_connection_error=authorization_failed") and stored(db) is None


async def test_status_says_which_provider_is_connected_and_which_are_available(client, db, g):
    before = (await client.get(f"{API}/status")).json()
    assert before["providers"] == {"microsoft": True, "google": True} and before["provider"] is None
    assert before["oauth_configured"] is True and before["connected"] is False
    await connect(client)
    resp = await client.get(f"{API}/status")
    body = resp.json()
    assert body["provider"] == "google" and body["connected"] is True and body["address"] == "ventas@example.test"
    assert_no_secrets(resp.text)


async def test_status_only_google_configured(client, db, monkeypatch):
    monkeypatch.setattr(gmail_client.settings, "mail_oauth_client_secret", "")
    body = (await client.get(f"{API}/status")).json()
    assert body["providers"] == {"microsoft": False, "google": True} and body["oauth_configured"] is True


async def test_the_test_button_reads_the_google_account_and_sends_nothing(client, db, g):
    await connect(client)
    g.calls.clear()
    resp = await client.post(f"{API}/test")
    assert resp.status_code == 200 and resp.json() == {"ok": True, "address": "ventas@example.test", "display_name": "Equipo Ventas"}
    assert [c["path"] for c in g.calls] == ["/v1/userinfo"] and g.sends() == []


async def test_connecting_the_other_provider_replaces_the_mailbox(client, db, g):
    await connect(client)
    assert stored(db)["provider"] == "google"
    with FakeMicrosoft() as ms:
        params = await start(client, "microsoft")
        resp = await client.post(f"{API}/callback", data={"state": params["state"], "code": "fake-auth-code"})
        assert resp.headers["location"].endswith("mail_connection=connected"), resp.headers["location"]
    assert stored(db)["provider"] == "microsoft"


async def test_an_expiring_gmail_token_is_renewed_with_google_and_keeps_its_refresh_token(db, g):
    now = {"t": T0}
    service = MailConnectionService(mail_oauth_states_repo, mail_connections_repo, clock=lambda: now["t"])
    db.put("mail_connections", USER, mailbox_doc(
        provider="google", scopes=["gmail.compose"], access_expires_at=T0 + timedelta(seconds=30)))
    g.token_replies.append((200, g.success(with_refresh=False)))
    token = await service.access_token(USER)
    assert token == "fake-access-token-1"
    assert g.calls_to("/token")[0]["host"] == "oauth2.googleapis.com"
    conn = stored(db)
    assert encryption_service.decrypt(conn["refresh_token_encrypted"]) == "fake-refresh-token-stored"
    assert conn["token_version"] == 2 and conn["provider"] == "google"


async def test_a_revoked_or_7_day_expired_google_grant_flags_reconnect(db, g):
    now = {"t": T0}
    service = MailConnectionService(mail_oauth_states_repo, mail_connections_repo, clock=lambda: now["t"])
    db.put("mail_connections", USER, mailbox_doc(
        provider="google", access_expires_at=T0 + timedelta(seconds=30)))
    g.token_replies.append((400, {"error": "invalid_grant"}))
    with pytest.raises(mail_connection_service.MailConnectionError) as exc:
        await service.access_token(USER)
    assert (exc.value.status_code, exc.value.code) == (409, "mailbox_reconnect_required")
    assert stored(db)["needs_reconnect"] is True and stored(db)["reconnect_reason"] == "refresh_refused"


async def test_for_send_says_the_provider(db, g):
    service = MailConnectionService(mail_oauth_states_repo, mail_connections_repo, clock=lambda: T0)
    db.put("mail_connections", USER, mailbox_doc(provider="google"))
    assert (await service.for_send(USER))["provider"] == "google"
    db.put("mail_connections", USER, mailbox_doc())
    assert (await service.for_send(USER))["provider"] == "microsoft"
    old = mailbox_doc()
    del old["provider"]                                  # saved before Gmail existed
    db.put("mail_connections", USER, old)
    assert (await service.for_send(USER))["provider"] == "microsoft"


# ══ sending through OutreachEmailService with a Gmail mailbox ════════════════
class GmailWorld:
    def __init__(self, db, g, ms, clock):
        self.db, self.g, self.ms, self.clock = db, g, ms, clock

    def email(self):
        return self.db.doc("outreach_emails", "e-1")

    def mailbox(self):
        return self.db.doc("mail_connections", USER)


@pytest.fixture
def world(monkeypatch):
    s = mail_connection_service.settings
    monkeypatch.setattr(s, "outreach_real_send_enabled", True)
    with use_fake_firestore() as db, FakeGoogle() as g, FakeMicrosoft() as ms:
        db.put("leads", "lead-1", LEAD)
        db.put("contacts", "c-1", CONTACT)
        db.put("outreach_emails", "e-1", EMAIL)
        db.put("pipeline_configs", USER, CONFIG)
        db.put("mail_connections", USER, mailbox_doc(provider="google", scopes=["gmail.compose"]))
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
            yield GmailWorld(db, g, ms, now)


async def send(client, **body):
    return await client.post(f"{SEND_API}/e-1/send", json={"confirm_to_email": RECIPIENT, **body})


async def test_send_goes_out_through_gmail_and_never_touches_microsoft(client, world):
    resp = await send(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "sent" and body["send_method"] == "platform"
    assert body["sender_address"] == "ventas@example.test"
    assert world.ms.calls == []                                     # Outlook was not involved
    [draft], [sent] = world.g.drafts_created(), world.g.sends()
    assert draft["headers"]["authorization"] == "Bearer fake-access-token-stored"
    mail = decode_raw(draft["json"]["message"]["raw"])
    assert mail["To"] == RECIPIENT and mail["Subject"] == EMAIL["subject"]
    text = mail.get_body(preferencelist=("plain",)).get_content()
    assert text.startswith("Hola Ana,") and text.rstrip().endswith(OUTREACH_UNSUBSCRIBE_LINE["es"])
    html = mail.get_body(preferencelist=("html",)).get_content()
    assert "Hola Ana," in html and OUTREACH_UNSUBSCRIBE_LINE["es"] in html
    assert world.g.reads() == [] and len(world.g.sent) == 1 and world.g.drafts == {}
    stored_email = world.email()
    assert stored_email["status"] == "sent" and stored_email["graph_message_id"] == sent["json"]["id"]
    assert stored_email["conversation_id"] == "fake-thread-1"
    assert stored_email["internet_message_id"] == mail["Message-ID"]
    assert_no_secrets(resp.text)


async def test_gmail_permission_removed_after_connecting_is_reported_and_the_email_stays_approved(client, world):
    world.g.next["draft"].append((403, {"error": {"errors": [{"reason": "insufficientPermissions"}]}}))
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "missing_permissions"
    assert world.email()["status"] == "approved" and world.g.sent == []


async def test_a_401_from_gmail_flags_the_mailbox_for_reconnection(client, world):
    world.g.next["draft"].append((401, {}))
    resp = await send(client)
    assert resp.status_code == 409 and code_of(resp) == "mailbox_reconnect_required"
    assert world.mailbox()["needs_reconnect"] is True
    again = await send(client)                                       # blocked until the user reconnects
    assert again.status_code == 409 and code_of(again) == "mailbox_reconnect_required"
    assert world.g.drafts_created().__len__() == 1


async def test_a_gmail_limit_is_throttling_and_the_user_can_retry(client, world):
    world.g.next["send"].append((429, {}, {"Retry-After": "20"}))
    resp = await send(client)
    assert resp.status_code == 503 and code_of(resp) == "mail_throttled"
    assert world.email()["status"] == "approved"
    ok = await send(client)                                          # the draft from the first try is reused
    assert ok.status_code == 200 and ok.json()["status"] == "sent"
    assert len(world.g.drafts_created()) == 1 and len(world.g.sent) == 1


@pytest.mark.parametrize("mode", [SENT_THEN_TIMEOUT, SENT_THEN_500])
async def test_a_lost_answer_stays_uncertain_because_gmail_cannot_confirm_the_send(client, world, mode):
    world.g.next["send"].append(mode)
    resp = await send(client)
    assert resp.status_code == 504 and code_of(resp) == "send_timeout"
    assert world.email()["send_lock"]["uncertain"] is True and world.email()["status"] == "approved"
    assert len(world.g.sent) == 1                    # it really went out: the user must be able to mark it as sent
    blocked = await send(client)                     # no second send without an explicit decision
    assert blocked.status_code >= 400 and len(world.g.sent) == 1
    manual = await client.patch(f"{SEND_API}/e-1/mark-sent")
    assert manual.status_code == 200 and manual.json()["send_method"] == "manual"


async def test_a_draft_deleted_by_the_user_is_created_again_on_the_next_try(client, world):
    world.g.next["send"].append((429, {}))
    await send(client)
    world.g.drafts.clear()                           # the user deleted it from Gmail
    ok = await send(client)
    assert ok.status_code == 200 and len(world.g.drafts_created()) == 2 and len(world.g.sent) == 1
