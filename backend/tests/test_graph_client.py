"""graph_client (RF-VTA-16, buzón de envío): authorization URL with PKCE and
form_post, code exchange, refresh with rotation, GET /me, error codes and the
custom-endpoint guard. Microsoft is faked in-process (tests/fake_microsoft.py);
no network. Synthetic data only."""
from __future__ import annotations

import base64
import hashlib

import httpx
import pytest

from app.config import DEFAULT_GRAPH_BASE_URL, DEFAULT_MICROSOFT_LOGIN_BASE_URL, Settings
from app.core.pipeline_constants import MAIL_OAUTH_SCOPES
from app.services import graph_client
from app.services.graph_client import GraphError
from tests.fake_microsoft import FakeMicrosoft, query_of

CLIENT_ID = "00000000-0000-0000-0000-000000000000"
CLIENT_SECRET = "fake-client-secret"
REDIRECT = "http://localhost:8000/api/v1/mail-connection/callback"


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    s = graph_client.settings
    monkeypatch.setattr(s, "app_env", "development")
    monkeypatch.setattr(s, "mail_oauth_client_id", CLIENT_ID)
    monkeypatch.setattr(s, "mail_oauth_client_secret", CLIENT_SECRET)
    monkeypatch.setattr(s, "mail_oauth_redirect_url", REDIRECT)
    monkeypatch.setattr(s, "microsoft_login_base_url", DEFAULT_MICROSOFT_LOGIN_BASE_URL)
    monkeypatch.setattr(s, "graph_base_url", DEFAULT_GRAPH_BASE_URL)
    monkeypatch.setattr(s, "mail_allow_custom_endpoints", False)


# ── PKCE and authorization URL ───────────────────────────────────────────────
def test_the_code_verifier_is_long_and_url_safe_and_the_challenge_is_s256():
    verifier = graph_client.new_code_verifier()
    assert 43 <= len(verifier) <= 128
    assert set(verifier) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert graph_client.code_challenge(verifier) == expected
    assert graph_client.new_code_verifier() != verifier


def test_the_authorization_url_asks_for_code_pkce_form_post_and_the_mail_scopes():
    url = graph_client.authorize_url("state-xyz", "challenge-abc")
    assert url.startswith(f"{DEFAULT_MICROSOFT_LOGIN_BASE_URL}/common/oauth2/v2.0/authorize?")
    q = query_of(url)
    assert q == {
        "client_id": CLIENT_ID, "response_type": "code", "response_mode": "form_post", "redirect_uri": REDIRECT,
        "scope": " ".join(MAIL_OAUTH_SCOPES), "state": "state-xyz", "code_challenge": "challenge-abc",
        "code_challenge_method": "S256", "prompt": "select_account",
    }
    assert CLIENT_SECRET not in url
    assert set(q["scope"].split()) == {"openid", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"}


def test_oauth_configured_needs_both_client_id_and_secret(monkeypatch):
    assert graph_client.oauth_configured() is True
    monkeypatch.setattr(graph_client.settings, "mail_oauth_client_secret", "  ")
    assert graph_client.oauth_configured() is False
    monkeypatch.setattr(graph_client.settings, "mail_oauth_client_secret", CLIENT_SECRET)
    monkeypatch.setattr(graph_client.settings, "mail_oauth_client_id", "")
    assert graph_client.oauth_configured() is False


# ── Custom endpoints (the local fake Graph) ──────────────────────────────────
def test_custom_endpoints_are_refused_without_the_switch(monkeypatch):
    monkeypatch.setattr(graph_client.settings, "graph_base_url", "http://localhost:9010/v1.0")
    with pytest.raises(GraphError) as err:
        graph_client.endpoints()
    assert err.value.code == "mail_endpoints_not_allowed" and err.value.status_code == 503


def test_custom_endpoints_are_allowed_with_the_switch_outside_production(monkeypatch):
    monkeypatch.setattr(graph_client.settings, "microsoft_login_base_url", "http://localhost:9010/")
    monkeypatch.setattr(graph_client.settings, "graph_base_url", "http://localhost:9010/v1.0/")
    monkeypatch.setattr(graph_client.settings, "mail_allow_custom_endpoints", True)
    assert graph_client.endpoints() == ("http://localhost:9010", "http://localhost:9010/v1.0")
    assert graph_client.authorize_url("s", "c").startswith("http://localhost:9010/common/oauth2/v2.0/authorize?")


def test_custom_endpoints_are_refused_in_production_even_with_the_switch(monkeypatch):
    monkeypatch.setattr(graph_client.settings, "graph_base_url", "http://localhost:9010/v1.0")
    monkeypatch.setattr(graph_client.settings, "mail_allow_custom_endpoints", True)
    monkeypatch.setattr(graph_client.settings, "app_env", "production")
    with pytest.raises(GraphError) as err:
        graph_client.endpoints()
    assert err.value.code == "mail_endpoints_not_allowed"


def test_settings_refuse_to_start_in_production_with_custom_mail_endpoints():
    with pytest.raises(Exception, match="GRAPH_BASE_URL"):
        Settings(_env_file=None, app_env="production", app_secret_key="a-real-secret",
                 graph_base_url="http://localhost:9010/v1.0")
    # The official ones are fine.
    Settings(_env_file=None, app_env="production", app_secret_key="a-real-secret")


# ── Code exchange ────────────────────────────────────────────────────────────
async def test_exchanging_the_code_sends_the_verifier_and_the_secret_and_returns_the_tokens():
    with FakeMicrosoft() as ms:
        tokens = await graph_client.exchange_code("fake-auth-code", "fake-verifier")
    [call] = ms.calls_to("/token")
    assert call["url"] == f"{DEFAULT_MICROSOFT_LOGIN_BASE_URL}/common/oauth2/v2.0/token"
    assert call["form"] == {
        "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "scope": " ".join(MAIL_OAUTH_SCOPES),
        "grant_type": "authorization_code", "code": "fake-auth-code", "redirect_uri": REDIRECT,
        "code_verifier": "fake-verifier",
    }
    assert tokens.access_token == "fake-access-token-1" and tokens.refresh_token == "fake-refresh-token-1"
    assert tokens.expires_in == 3600
    assert set(tokens.scopes) == set(MAIL_OAUTH_SCOPES)
    assert "fake-access-token" not in repr(tokens) and "fake-refresh-token" not in repr(tokens)


async def test_granted_scopes_lose_their_resource_prefix():
    with FakeMicrosoft() as ms:
        ms.granted_scopes = "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite openid"
        tokens = await graph_client.exchange_code("fake-auth-code", "v")
    assert tokens.scopes == ("Mail.Send", "Mail.ReadWrite", "openid")


async def test_a_token_reply_without_refresh_token_keeps_it_empty_on_exchange():
    with FakeMicrosoft() as ms:
        ms.token_replies.append((200, ms.success(with_refresh=False)))
        tokens = await graph_client.exchange_code("fake-auth-code", "v")
    assert tokens.refresh_token == ""


# ── Refresh ──────────────────────────────────────────────────────────────────
async def test_refresh_returns_the_rotated_refresh_token():
    with FakeMicrosoft() as ms:
        tokens = await graph_client.refresh("fake-refresh-token-old")
    [call] = ms.calls_to("/token")
    assert call["form"]["grant_type"] == "refresh_token"
    assert call["form"]["refresh_token"] == "fake-refresh-token-old"
    assert tokens.refresh_token == "fake-refresh-token-1"


async def test_refresh_keeps_the_current_refresh_token_when_none_comes_back():
    with FakeMicrosoft() as ms:
        ms.token_replies.append((200, ms.success(with_refresh=False)))
        tokens = await graph_client.refresh("fake-refresh-token-old")
    assert tokens.refresh_token == "fake-refresh-token-old"


@pytest.mark.parametrize("error", ["invalid_grant", "interaction_required", "consent_required", "login_required"])
async def test_a_refused_refresh_means_reconnect(error):
    with FakeMicrosoft() as ms:
        ms.token_replies.append((400, {"error": error, "error_description": "AADSTS70008: fake-detail"}))
        with pytest.raises(GraphError) as err:
            await graph_client.refresh("fake-refresh-token-old")
    assert err.value.code == "mailbox_reconnect_required" and err.value.status_code == 409
    assert "AADSTS" not in str(err.value.detail) and "fake-detail" not in str(err.value)


@pytest.mark.parametrize("reply, code, status", [
    ((400, {"error": "invalid_client"}), "mailbox_auth_failed", 502),
    ((401, {"error": "unauthorized_client"}), "mailbox_auth_failed", 502),
    ((500, {"error": "server_error"}), "mail_service_unavailable", 502),
    ((503, "unavailable"), "mail_service_unavailable", 502),
    ((200, "<html>not json</html>"), "mail_service_unavailable", 502),
    ((200, {"token_type": "Bearer"}), "mail_service_unavailable", 502),
])
async def test_token_failures_become_codes(reply, code, status):
    with FakeMicrosoft() as ms:
        ms.token_replies.append(reply)
        with pytest.raises(GraphError) as err:
            await graph_client.refresh("fake-refresh-token-old")
    assert (err.value.code, err.value.status_code) == (code, status)


async def test_throttling_carries_retry_after():
    with FakeMicrosoft() as ms:
        ms.token_replies.append((429, {"error": "throttled"}, {"Retry-After": "7"}))
        with pytest.raises(GraphError) as err:
            await graph_client.refresh("fake-refresh-token-old")
    assert err.value.code == "mail_throttled" and err.value.status_code == 503
    assert err.value.detail == {"code": "mail_throttled", "retry_after": 7}


@pytest.mark.parametrize("exc, code, status", [
    (httpx.ReadTimeout("t"), "mail_service_timeout", 504),
    (httpx.ConnectTimeout("t"), "mail_service_timeout", 504),
    (httpx.ConnectError("c"), "mail_service_unavailable", 502),
])
async def test_network_failures_become_codes(exc, code, status):
    with FakeMicrosoft() as ms:
        ms.fail_with = exc
        with pytest.raises(GraphError) as err:
            await graph_client.refresh("fake-refresh-token-old")
    assert (err.value.code, err.value.status_code) == (code, status)
    assert err.value.__suppress_context__ is True


async def test_redirects_are_never_followed():
    with FakeMicrosoft() as ms:
        ms.token_replies.append((302, {}, {"Location": "https://elsewhere.example.test/"}))
        with pytest.raises(GraphError) as err:
            await graph_client.refresh("fake-refresh-token-old")
    assert err.value.code == "mailbox_auth_failed"
    assert len(ms.calls) == 1


# ── GET /me ──────────────────────────────────────────────────────────────────
async def test_me_reads_only_the_mailbox_fields_with_the_bearer_token():
    with FakeMicrosoft() as ms:
        me = await graph_client.get_me("fake-access-token-9")
    [call] = ms.calls_to("/me")
    assert call["url"].startswith(f"{DEFAULT_GRAPH_BASE_URL}/me?")
    assert call["params"] == {"$select": "id,displayName,mail,userPrincipalName"}
    assert call["headers"]["authorization"] == "Bearer fake-access-token-9"
    assert me == {"id": "fake-account-id", "address": "ventas@example.test", "display_name": "Equipo Ventas"}


async def test_me_falls_back_to_the_user_principal_name_for_personal_accounts():
    with FakeMicrosoft() as ms:
        ms.me = (200, {"id": "x", "displayName": "Persona", "mail": None, "userPrincipalName": "persona@example.test"})
        me = await graph_client.get_me("fake-access-token-9")
    assert me["address"] == "persona@example.test"


@pytest.mark.parametrize("reply, code", [
    ((200, {"id": "x", "mail": None, "userPrincipalName": "no-at-sign"}), "mailbox_without_address"),
    ((401, {"error": {"code": "InvalidAuthenticationToken"}}), "mailbox_reconnect_required"),
    ((403, {"error": {"code": "Authorization_RequestDenied"}}), "missing_permissions"),
    ((404, {}), "mail_service_unavailable"),
    ((502, {}), "mail_service_unavailable"),
    ((429, {}, {"Retry-After": "x"}), "mail_throttled"),
])
async def test_me_failures_become_codes(reply, code):
    with FakeMicrosoft() as ms:
        ms.me = reply
        with pytest.raises(GraphError) as err:
            await graph_client.get_me("fake-access-token-9")
    assert err.value.code == code
    if code == "mail_throttled":
        assert err.value.detail == {"code": "mail_throttled"}  # unreadable Retry-After is left out


# ── Messages (only the platform's own) ───────────────────────────────────────
from tests.fake_microsoft import SENT_THEN_500, SENT_THEN_TIMEOUT  # noqa: E402


async def test_create_draft_posts_plain_text_to_one_recipient_with_immutable_ids():
    with FakeMicrosoft() as ms:
        ids = await graph_client.create_draft("fake-access-token-9", "Asunto\nsegunda línea", "Cuerpo\n", "ana@example.test")
    [call] = ms.drafts_created()
    assert call["url"] == f"{DEFAULT_GRAPH_BASE_URL}/me/messages"
    assert call["headers"]["authorization"] == "Bearer fake-access-token-9"
    assert call["headers"]["prefer"] == 'IdType="ImmutableId"'
    assert call["json"] == {
        "subject": "Asunto segunda línea",
        "body": {"contentType": "Text", "content": "Cuerpo\n"},
        "toRecipients": [{"emailAddress": {"address": "ana@example.test"}}],
    }
    message = ms.messages[ids["id"]]
    assert message["isDraft"] is True and ms.sent_messages() == []          # nothing was sent
    assert ids == {"id": message["id"], "internet_message_id": message["internetMessageId"],
                   "conversation_id": message["conversationId"]}


@pytest.mark.parametrize("reply, code", [
    ((400, {}), "mail_rejected"), ((404, {}), "mail_rejected"), ((401, {}), "mailbox_reconnect_required"),
    ((403, {}), "missing_permissions"), ((429, {}), "mail_throttled"), ((500, {}), "mail_service_unavailable"),
    ((201, {"subject": "sin id"}), "mail_service_unavailable"),
])
async def test_create_draft_failures_are_safe_codes(reply, code):
    with FakeMicrosoft() as ms:
        ms.next["draft"].append(reply)
        with pytest.raises(GraphError) as err:
            await graph_client.create_draft("t", "s", "b", "ana@example.test")
    assert err.value.code == code and err.value.uncertain is False


async def test_send_draft_sends_the_draft_by_its_escaped_id():
    with FakeMicrosoft() as ms:
        ids = await graph_client.create_draft("t", "s", "b", "ana@example.test")
        await graph_client.send_draft("t", ids["id"])
    [call] = ms.sends()
    assert call["raw_path"] == "/v1.0/me/messages/AAMk-fake%2Fimmutable%2B1%3D%3D/send"
    assert ms.messages[ids["id"]]["isDraft"] is False


@pytest.mark.parametrize("planned, code, uncertain", [
    ((400, {}), "mail_rejected", False),
    ((401, {}), "mailbox_reconnect_required", False),
    ((429, {}), "mail_throttled", False),
    (httpx.ConnectError("c"), "mail_service_unavailable", False),   # never reached Microsoft
    (httpx.ConnectTimeout("c"), "mail_service_timeout", False),
    (httpx.ReadTimeout("t"), "send_timeout", True),                  # may have been accepted
    (httpx.WriteTimeout("t"), "send_timeout", True),
    (httpx.RemoteProtocolError("dropped"), "send_timeout", True),
    ((500, {}), "send_timeout", True),
    ((503, {}), "send_timeout", True),
    (SENT_THEN_TIMEOUT, "send_timeout", True),
    (SENT_THEN_500, "send_timeout", True),
])
async def test_send_draft_tells_safe_failures_from_uncertain_ones(planned, code, uncertain):
    with FakeMicrosoft() as ms:
        ids = await graph_client.create_draft("t", "s", "b", "ana@example.test")
        ms.next["send"].append(planned)
        with pytest.raises(GraphError) as err:
            await graph_client.send_draft("t", ids["id"])
    assert (err.value.code, err.value.uncertain) == (code, uncertain)
    assert "uncertain" not in err.value.detail


async def test_reading_a_message_selects_only_its_state():
    with FakeMicrosoft() as ms:
        ids = await graph_client.create_draft("t", "s", "b", "ana@example.test")
        draft = await graph_client.get_message_state("t", ids["id"])
        await graph_client.send_draft("t", ids["id"])
        sent = await graph_client.get_message_state("t", ids["id"])
        gone = await graph_client.get_message_state("t", "AAMk-not-there")
    assert draft["is_draft"] is True and sent["is_draft"] is False and gone is None
    for call in ms.reads():
        assert call["params"] == {"$select": "isDraft,internetMessageId,conversationId"}
        assert call["headers"]["prefer"] == 'IdType="ImmutableId"'


@pytest.mark.parametrize("reply, code", [((401, {}), "mailbox_reconnect_required"), ((500, {}), "mail_service_unavailable"),
                                         ((200, {"id": "x"}), "mail_service_unavailable")])
async def test_reading_failures_become_codes(reply, code):
    with FakeMicrosoft() as ms:
        ms.next["read"].append(reply)
        with pytest.raises(GraphError) as err:
            await graph_client.get_message_state("t", "AAMk-x")
    assert err.value.code == code


def test_the_client_has_no_way_to_list_or_read_other_messages():
    """Ajuste 1: only messages the platform created are read, by their id."""
    import inspect

    source = inspect.getsource(graph_client)
    # The only URLs under /me/messages: the collection (POST, to create a
    # draft) and one message by id (_message_url).
    assert source.count('f"{graph}/me/messages"') == 1
    assert source.count('f"{graph}/me/messages/') == 1
    create = inspect.getsource(graph_client.create_draft)
    assert '"POST", f"{graph}/me/messages"' in create
    public = {name for name, fn in inspect.getmembers(graph_client, inspect.iscoroutinefunction) if not name.startswith("_")}
    assert public == {"exchange_code", "refresh", "get_me", "create_draft", "send_draft", "get_message_state"}
    assert list(inspect.signature(graph_client.get_message_state).parameters) == ["access_token", "message_id"]
