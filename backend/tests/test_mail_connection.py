"""/api/v1/mail-connection (RF-VTA-16, buzón de envío): connect a Microsoft
mailbox by OAuth (code + PKCE, form_post callback), its status, test and
disconnect, and the access token with refresh and reconnect.

In-memory Firestore (tests/fake_firestore.py) and Microsoft faked in-process
(tests/fake_microsoft.py): no network, no real Firestore. Synthetic data only;
every token starts with "fake-"."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.fernet import Fernet

from app.config import DEFAULT_GRAPH_BASE_URL, DEFAULT_MICROSOFT_LOGIN_BASE_URL
from app.core.pipeline_constants import MAIL_OAUTH_STATE_TTL_SECONDS
from app.services import encryption_service, mail_connection_service
from app.services.firestore_service import MailConnectionsRepo, MailOAuthStatesRepo
from app.services.mail_connection_service import MailConnectionError, MailConnectionService, consent_error_code
from tests.conftest import FAKE_USER_SUB
from tests.fake_firestore import use_fake_firestore
from tests.fake_microsoft import FakeMicrosoft, query_of

API = "/api/v1/mail-connection"
USER = FAKE_USER_SUB
FRONTEND = "http://frontend.example.test"
SECRET_MARKERS = ("fake-access-token", "fake-refresh-token", "fake-auth-code", "fake-client-secret")


@pytest.fixture
def db(monkeypatch):
    s = mail_connection_service.settings
    monkeypatch.delenv("VERCEL_PROJECT_PRODUCTION_URL", raising=False)
    monkeypatch.setattr(s, "app_env", "development")
    monkeypatch.setattr(s, "frontend_url", FRONTEND)
    monkeypatch.setattr(s, "mail_oauth_client_id", "00000000-0000-0000-0000-000000000000")
    monkeypatch.setattr(s, "mail_oauth_client_secret", "fake-client-secret")
    monkeypatch.setattr(s, "mail_oauth_redirect_url", "http://localhost:8000/api/v1/mail-connection/callback")
    monkeypatch.setattr(s, "microsoft_login_base_url", DEFAULT_MICROSOFT_LOGIN_BASE_URL)
    monkeypatch.setattr(s, "graph_base_url", DEFAULT_GRAPH_BASE_URL)
    monkeypatch.setattr(s, "mail_allow_custom_endpoints", False)
    monkeypatch.setattr(s, "pipeline_encryption_key", Fernet.generate_key().decode())
    encryption_service._fernet.cache_clear()
    with use_fake_firestore() as fake:
        yield fake
    encryption_service._fernet.cache_clear()


@pytest.fixture
def ms():
    with FakeMicrosoft() as fake:
        yield fake


async def start(client) -> dict:
    resp = await client.post(f"{API}/start")
    assert resp.status_code == 200, resp.text
    return query_of(resp.json()["authorize_url"])


async def callback(client, **form):
    return await client.post(f"{API}/callback", data=form)


async def connect(client) -> dict:
    """Start + a successful callback; the authorization request's params."""
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.headers["location"] == f"{FRONTEND}/?mail_connection=connected", resp.headers["location"]
    return params


def stored(db) -> dict:
    return db.doc("mail_connections", USER)


def assert_no_secrets(text: str) -> None:
    for marker in SECRET_MARKERS:
        assert marker not in text, marker


# ── start ────────────────────────────────────────────────────────────────────
async def test_start_stores_a_hashed_single_use_state_and_an_encrypted_verifier(client, db):
    params = await start(client)
    state = params["state"]
    assert len(state) >= 40
    [(collection, doc_id, data)] = db.writes_to("mail_oauth_states")
    assert db.writes_to("mail_connections") == []
    assert doc_id == MailOAuthStatesRepo.doc_id_for(state) and state not in doc_id
    assert state not in str(data)
    assert data["user_id"] == USER and data["used"] is False
    verifier = encryption_service.decrypt(data["code_verifier_encrypted"])
    assert verifier not in str(data)
    # The challenge sent to Microsoft is the S256 of that verifier.
    from app.services import graph_client
    assert params["code_challenge"] == graph_client.code_challenge(verifier)
    assert params["code_challenge_method"] == "S256" and params["response_mode"] == "form_post"
    ttl = data["expires_at"] - datetime.now(timezone.utc)
    assert timedelta(seconds=MAIL_OAUTH_STATE_TTL_SECONDS - 5) < ttl <= timedelta(seconds=MAIL_OAUTH_STATE_TTL_SECONDS)


async def test_each_start_draws_a_new_state(client, db):
    assert (await start(client))["state"] != (await start(client))["state"]


@pytest.mark.parametrize("setting, value, code", [
    ("mail_oauth_client_id", "", "mail_oauth_not_configured"),
    ("mail_oauth_client_secret", "", "mail_oauth_not_configured"),
    ("graph_base_url", "http://localhost:9010/v1.0", "mail_endpoints_not_allowed"),
    ("pipeline_encryption_key", "", "encryption_not_configured"),
])
async def test_start_is_refused_without_what_it_needs(client, db, monkeypatch, setting, value, code):
    monkeypatch.setattr(mail_connection_service.settings, setting, value)
    encryption_service._fernet.cache_clear()
    resp = await client.post(f"{API}/start")
    assert resp.status_code == 503
    assert resp.json()["detail"] == {"code": code}
    assert db.writes_to("mail_oauth_states") == [] and db.writes_to("mail_connections") == []


# ── callback ─────────────────────────────────────────────────────────────────
async def test_a_good_callback_stores_the_mailbox_with_encrypted_tokens(client, db, ms):
    await connect(client)
    [token_call] = ms.calls_to("/token")
    assert token_call["form"]["grant_type"] == "authorization_code"
    assert token_call["form"]["code"] == "fake-auth-code"
    # The verifier sent is the one stored for that state.
    state_doc = db.writes_to("mail_oauth_states")[0][2]
    assert token_call["form"]["code_verifier"] == encryption_service.decrypt(state_doc["code_verifier_encrypted"])

    conn = stored(db)
    assert conn["user_id"] == USER and conn["address"] == "ventas@example.test"
    assert conn["display_name"] == "Equipo Ventas" and conn["needs_reconnect"] is False
    assert conn["token_version"] == 1 and "Mail.Send" in conn["scopes"]
    assert encryption_service.decrypt(conn["access_token_encrypted"]) == "fake-access-token-1"
    assert encryption_service.decrypt(conn["refresh_token_encrypted"]) == "fake-refresh-token-1"
    assert_no_secrets(str(db.writes))
    # The state is now used.
    [state_doc_id] = db.data["mail_oauth_states"]
    assert db.doc("mail_oauth_states", state_doc_id)["used"] is True


async def test_the_callback_redirects_without_caching_and_without_secrets(client, db, ms):
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.status_code == 303
    assert resp.headers["cache-control"] == "no-store"
    assert_no_secrets(resp.headers["location"])
    assert params["state"] not in resp.headers["location"]


async def test_a_state_works_only_once(client, db, ms):
    params = await start(client)
    await callback(client, state=params["state"], code="fake-auth-code")
    again = await callback(client, state=params["state"], code="fake-auth-code-2")
    assert again.headers["location"] == f"{FRONTEND}/?mail_connection_error=invalid_state"
    assert len(ms.calls_to("/token")) == 1


async def test_an_unknown_or_missing_state_is_refused_without_calling_microsoft(client, db, ms):
    for form in ({"state": "not-a-state", "code": "fake-auth-code"}, {"code": "fake-auth-code"}):
        resp = await callback(client, **form)
        assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error=invalid_state"
    assert ms.calls == [] and stored(db) is None


async def test_an_expired_state_is_refused_and_cannot_come_back(client, db, ms):
    params = await start(client)
    doc_id = MailOAuthStatesRepo.doc_id_for(params["state"])
    db.data["mail_oauth_states"][doc_id]["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error=invalid_state"
    assert db.doc("mail_oauth_states", doc_id)["used"] is True
    assert ms.calls == [] and stored(db) is None


async def test_the_mailbox_goes_to_the_user_who_started_not_to_whoever_calls_back(client, db, ms):
    # Another user started; the callback (no session needed) connects *their* mailbox.
    svc = mail_connection_service.get_service()
    params = query_of((await svc.start("other-user"))["authorize_url"])
    await callback(client, state=params["state"], code="fake-auth-code")
    assert db.doc("mail_connections", "other-user")["user_id"] == "other-user"
    assert stored(db) is None


@pytest.mark.parametrize("error, description, code", [
    ("access_denied", "AADSTS65004: User declined to consent.", "consent_denied"),
    ("access_denied", "AADSTS90094: Admin approval required.", "admin_consent_required"),
    ("consent_required", "AADSTS90095: needs admin", "admin_consent_required"),
    ("server_error", "", "authorization_failed"),
])
async def test_a_microsoft_error_is_reported_by_code_and_consumes_the_state(client, db, ms, error, description, code):
    params = await start(client)
    resp = await callback(client, state=params["state"], error=error, error_description=description)
    assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error={code}"
    assert "AADSTS" not in resp.headers["location"]
    assert db.doc("mail_oauth_states", MailOAuthStatesRepo.doc_id_for(params["state"]))["used"] is True
    assert ms.calls == [] and stored(db) is None


def test_consent_error_codes():
    assert consent_error_code("access_denied", None) == "consent_denied"
    assert consent_error_code("invalid_request", "AADSTS90094 x") == "admin_consent_required"
    assert consent_error_code("temporarily_unavailable", "x") == "authorization_failed"


async def test_a_callback_without_code_fails(client, db, ms):
    params = await start(client)
    resp = await callback(client, state=params["state"])
    assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error=authorization_failed"
    assert ms.calls == []


@pytest.mark.parametrize("reply, code", [
    ((400, {"error": "invalid_grant"}), "authorization_failed"),      # code expired / reused / wrong verifier
    ((400, {"error": "invalid_client"}), "authorization_failed"),
    ((503, {}), "mail_service_unavailable"),
])
async def test_a_failed_exchange_stores_nothing(client, db, ms, reply, code):
    ms.token_replies.append(reply)
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error={code}"
    assert stored(db) is None


@pytest.mark.parametrize("scopes, with_refresh", [
    ("openid offline_access User.Read Mail.ReadWrite", True),   # no Mail.Send
    ("openid offline_access User.Read Mail.Send", True),        # no Mail.ReadWrite
    ("openid User.Read Mail.ReadWrite Mail.Send", False),       # no refresh token (offline_access)
])
async def test_a_partial_consent_is_refused(client, db, ms, scopes, with_refresh):
    ms.granted_scopes = scopes
    ms.token_replies.append((200, ms.success(with_refresh=with_refresh)))
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error=missing_permissions"
    assert stored(db) is None and ms.calls_to("/me") == []


async def test_a_mailbox_without_address_is_refused(client, db, ms):
    ms.me = (200, {"id": "x", "displayName": "Sin buzón", "mail": None, "userPrincipalName": ""})
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error=mailbox_without_address"
    assert stored(db) is None


async def test_an_unexpected_failure_still_lands_on_the_frontend(client, db, ms, monkeypatch):
    async def boom(*args, **kwargs):
        raise RuntimeError("fake-access-token-boom")
    monkeypatch.setattr(mail_connection_service.graph_client, "get_me", boom)
    params = await start(client)
    resp = await callback(client, state=params["state"], code="fake-auth-code")
    assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error=server_error"


async def test_reconnecting_replaces_the_previous_connection(client, db, ms):
    await connect(client)
    db.data["mail_connections"][USER]["needs_reconnect"] = True
    await connect(client)
    conn = stored(db)
    assert conn["needs_reconnect"] is False and conn["token_version"] == 1
    assert encryption_service.decrypt(conn["refresh_token_encrypted"]) == "fake-refresh-token-2"


# ── status / disconnect ──────────────────────────────────────────────────────
async def test_status_before_and_after_connecting_never_shows_a_token(client, db, ms):
    before = (await client.get(f"{API}/status")).json()
    assert before == {
        "oauth_configured": True, "connected": False, "needs_reconnect": False,
        "address": None, "display_name": None, "connected_at": None,
    }
    await connect(client)
    resp = await client.get(f"{API}/status")
    body = resp.json()
    assert body["connected"] is True and body["needs_reconnect"] is False
    assert body["address"] == "ventas@example.test" and body["display_name"] == "Equipo Ventas"
    assert body["connected_at"]
    assert set(body) == {"oauth_configured", "connected", "needs_reconnect", "address", "display_name", "connected_at"}
    assert_no_secrets(resp.text)
    assert "encrypted" not in resp.text


async def test_status_says_when_the_server_has_no_app_registration(client, db, monkeypatch):
    monkeypatch.setattr(mail_connection_service.settings, "mail_oauth_client_secret", "")
    assert (await client.get(f"{API}/status")).json()["oauth_configured"] is False


async def test_status_ignores_a_connection_stored_for_someone_else(client, db):
    db.put("mail_connections", USER, {"user_id": "someone-else", "address": "x@example.test"})
    assert (await client.get(f"{API}/status")).json()["connected"] is False


async def test_disconnect_forgets_the_mailbox(client, db, ms):
    await connect(client)
    resp = await client.delete(API)
    assert resp.status_code == 204
    assert stored(db) is None
    assert (await client.get(f"{API}/status")).json()["connected"] is False
    # Disconnecting again is harmless.
    assert (await client.delete(API)).status_code == 204


# ── test (and the access token behind it) ────────────────────────────────────
async def test_test_reads_the_mailbox_with_the_stored_token_and_sends_nothing(client, db, ms):
    await connect(client)
    ms.calls.clear()
    resp = await client.post(f"{API}/test")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "address": "ventas@example.test", "display_name": "Equipo Ventas"}
    assert [c["path"] for c in ms.calls] == ["/v1.0/me"]          # no refresh: the token is fresh
    assert ms.calls[0]["headers"]["authorization"] == "Bearer fake-access-token-1"
    assert all(c["method"] == "GET" for c in ms.calls)


async def test_test_without_a_mailbox(client, db):
    resp = await client.post(f"{API}/test")
    assert resp.status_code == 409 and resp.json()["detail"] == {"code": "mailbox_not_connected"}


async def test_an_expiring_token_is_refreshed_and_the_rotated_refresh_token_stored(client, db, ms):
    await connect(client)
    db.data["mail_connections"][USER]["access_expires_at"] = datetime.now(timezone.utc) + timedelta(seconds=60)
    ms.calls.clear()
    resp = await client.post(f"{API}/test")
    assert resp.status_code == 200
    [refresh_call] = ms.calls_to("/token")
    assert refresh_call["form"]["refresh_token"] == "fake-refresh-token-1"
    assert ms.calls_to("/me")[0]["headers"]["authorization"] == "Bearer fake-access-token-2"
    conn = stored(db)
    assert conn["token_version"] == 2
    assert encryption_service.decrypt(conn["refresh_token_encrypted"]) == "fake-refresh-token-2"
    assert encryption_service.decrypt(conn["access_token_encrypted"]) == "fake-access-token-2"
    assert conn["access_expires_at"] > datetime.now(timezone.utc) + timedelta(minutes=50)
    assert_no_secrets(str(db.writes))


async def test_a_refused_refresh_flags_reconnect_and_blocks_until_connecting_again(client, db, ms):
    await connect(client)
    db.data["mail_connections"][USER]["access_expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    ms.token_replies.append((400, {"error": "invalid_grant", "error_description": "AADSTS70008: expired"}))
    resp = await client.post(f"{API}/test")
    assert resp.status_code == 409 and resp.json()["detail"] == {"code": "mailbox_reconnect_required"}
    conn = stored(db)
    assert conn["needs_reconnect"] is True and conn["reconnect_reason"] == "refresh_refused"
    assert (await client.get(f"{API}/status")).json()["needs_reconnect"] is True
    # From now on, no call to Microsoft until the user connects again.
    ms.calls.clear()
    assert (await client.post(f"{API}/test")).json()["detail"] == {"code": "mailbox_reconnect_required"}
    assert ms.calls == []


async def test_unreadable_tokens_flag_reconnect(client, db, ms, monkeypatch):
    await connect(client)
    # The encryption key changed: the stored tokens can no longer be read.
    monkeypatch.setattr(mail_connection_service.settings, "pipeline_encryption_key", Fernet.generate_key().decode())
    encryption_service._fernet.cache_clear()
    ms.calls.clear()
    resp = await client.post(f"{API}/test")
    assert resp.status_code == 409 and resp.json()["detail"] == {"code": "mailbox_reconnect_required"}
    assert stored(db)["reconnect_reason"] == "tokens_unreadable"
    assert ms.calls == []


async def test_a_temporary_failure_does_not_flag_reconnect(client, db, ms):
    await connect(client)
    db.data["mail_connections"][USER]["access_expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    ms.token_replies.append((429, {}, {"Retry-After": "3"}))
    resp = await client.post(f"{API}/test")
    assert resp.status_code == 503
    assert resp.json()["detail"] == {"code": "mail_throttled", "retry_after": 3}
    assert stored(db)["needs_reconnect"] is False


async def test_a_token_revoked_on_microsofts_side_flags_reconnect_on_test(client, db, ms):
    await connect(client)
    ms.me = (401, {"error": {"code": "InvalidAuthenticationToken"}})
    resp = await client.post(f"{API}/test")
    assert resp.status_code == 409 and resp.json()["detail"] == {"code": "mailbox_reconnect_required"}
    assert stored(db)["needs_reconnect"] is True


# ── concurrency of the refresh (service level) ──────────────────────────────
def service(db) -> MailConnectionService:
    return MailConnectionService(MailOAuthStatesRepo(), MailConnectionsRepo())


async def test_a_concurrent_refresh_does_not_overwrite_the_newer_tokens(client, db, ms):
    await connect(client)
    db.data["mail_connections"][USER]["access_expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    other = encryption_service.encrypt("fake-refresh-token-from-another-request")

    def someone_else_refreshes_first():
        doc = db.data["mail_connections"][USER]
        doc["token_version"] = 2
        doc["refresh_token_encrypted"] = other

    ms.on_token = someone_else_refreshes_first
    token = await service(db).access_token(USER)
    assert token == "fake-access-token-2"                     # still usable for this call
    conn = stored(db)
    assert conn["token_version"] == 2 and conn["refresh_token_encrypted"] == other   # theirs kept


async def test_a_disconnect_during_a_refresh_drops_the_new_tokens(client, db, ms):
    await connect(client)
    db.data["mail_connections"][USER]["access_expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    ms.on_token = lambda: db.data["mail_connections"].pop(USER)
    with pytest.raises(MailConnectionError) as err:
        await service(db).access_token(USER)
    assert err.value.code == "mailbox_not_connected"
    assert stored(db) is None


# ── logs and authentication ──────────────────────────────────────────────────
async def test_nothing_secret_or_personal_is_logged(client, db, ms, caplog):
    caplog.set_level(logging.DEBUG)
    params = await connect(client)
    db.data["mail_connections"][USER]["access_expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    await client.post(f"{API}/test")
    ms.token_replies.append((400, {"error": "invalid_grant", "error_description": "AADSTS70008: fake-detail"}))
    db.data["mail_connections"][USER]["access_expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    await client.post(f"{API}/test")
    await callback(client, state=params["state"], code="fake-auth-code")  # reused state
    text = caplog.text
    assert_no_secrets(text)
    assert params["state"] not in text and params["code_challenge"] not in text
    assert "ventas@example.test" not in text and "AADSTS" not in text and "fake-detail" not in text


async def test_every_route_but_the_callback_needs_a_session(app, client, db, ms):
    from app.dependencies.auth import get_current_user

    saved = app.dependency_overrides.pop(get_current_user)
    try:
        for method, path in (("POST", "/start"), ("GET", "/status"), ("POST", "/test"), ("DELETE", "")):
            resp = await client.request(method, f"{API}{path}")
            assert resp.status_code in (401, 403), (method, path, resp.status_code)
        # The callback is reached without a session (and refuses a bad state).
        resp = await callback(client, state="not-a-state", code="fake-auth-code")
        assert resp.status_code == 303
        assert resp.headers["location"] == f"{FRONTEND}/?mail_connection_error=invalid_state"
    finally:
        app.dependency_overrides[get_current_user] = saved
    assert ms.calls == [] and db.writes_to("mail_connections") == []


async def test_the_callback_accepts_only_a_post(client, db):
    resp = await client.get(f"{API}/callback", params={"state": "s", "code": "fake-auth-code"})
    assert resp.status_code == 405
