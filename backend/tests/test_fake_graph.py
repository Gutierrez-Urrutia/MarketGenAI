"""scripts/dev/fake_graph.py — the local fake of Microsoft identity + Graph
used by the end-to-end test of the sending mailbox (RF-VTA-16, phase 4).

In-process only (httpx ASGITransport): no network, no Firestore. Checks that
the fake behaves like the parts of Microsoft that graph_client uses (PKCE,
single-use codes, refresh-token rotation, drafts and send, failure modes),
that the real graph_client works against it, and that the fake itself can
never send anything out."""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from app.services import graph_client
from scripts.dev import fake_graph
from scripts.dev.fake_graph import Config, auto_post_form, create_app, s256

BASE = "http://127.0.0.1:8765"
CLIENT_ID = "00000000-0000-0000-0000-000000000000"
SECRET = "fake-client-secret"
REDIRECT = "http://localhost:8000/api/v1/mail-connection/callback"
VERIFIER = "v" * 64


def make_app(tmp_path: Path | None = None):
    return create_app(Config(client_id=CLIENT_ID, client_secret=SECRET, redirect_uri=REDIRECT,
                             log_path=(tmp_path / "fake.jsonl") if tmp_path else None, slow_seconds=0))


def client_for(app, host: str = "127.0.0.1") -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(host, 50000)), base_url=BASE)


def authorize_params(**overrides):
    params = {
        "client_id": CLIENT_ID, "response_type": "code", "response_mode": "form_post",
        "redirect_uri": REDIRECT, "scope": "openid offline_access User.Read Mail.ReadWrite Mail.Send",
        "state": "state-sintetico", "code_challenge": s256(VERIFIER), "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    params.update(overrides)
    return params


def form_fields(page: str) -> dict:
    return dict(re.findall(r'<input type="hidden" name="([^"]+)" value="([^"]*)">', page))


async def get_code(c: httpx.AsyncClient) -> str:
    resp = await c.get("/common/oauth2/v2.0/authorize", params=authorize_params())
    assert resp.status_code == 200
    fields = form_fields(resp.text)
    assert fields["state"] == "state-sintetico"
    return fields["code"]


async def exchange(c: httpx.AsyncClient, code: str, verifier: str = VERIFIER, secret: str = SECRET):
    return await c.post("/common/oauth2/v2.0/token", data={
        "client_id": CLIENT_ID, "client_secret": secret, "grant_type": "authorization_code",
        "code": code, "redirect_uri": REDIRECT, "code_verifier": verifier,
    })


async def tokens(c: httpx.AsyncClient) -> dict:
    resp = await exchange(c, await get_code(c))
    assert resp.status_code == 200, resp.text
    return resp.json()


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Prefer": 'IdType="ImmutableId"'}


# ── authorize + token ────────────────────────────────────────────────────────
async def test_authorize_posts_code_and_state_to_the_redirect_uri():
    async with client_for(make_app()) as c:
        resp = await c.get("/common/oauth2/v2.0/authorize", params=authorize_params())
    assert resp.status_code == 200
    assert f'method="post" action="{REDIRECT}"' in resp.text
    assert "submit()" in resp.text
    assert set(form_fields(resp.text)) == {"code", "state"}


@pytest.mark.parametrize("field,value", [
    ("client_id", "otro"), ("redirect_uri", "http://evil.example.test/cb"), ("response_mode", "query"),
    ("code_challenge_method", "plain"), ("state", ""),
])
async def test_authorize_refuses_a_bad_request(field, value):
    async with client_for(make_app()) as c:
        resp = await c.get("/common/oauth2/v2.0/authorize", params=authorize_params(**{field: value}))
    assert resp.status_code == 400
    assert "<form" not in resp.text


async def test_pkce_code_is_single_use_and_needs_the_right_verifier():
    async with client_for(make_app()) as c:
        code = await get_code(c)
        assert (await exchange(c, code, verifier="w" * 64)).json()["error"] == "invalid_grant"
        ok = await exchange(c, code)
        assert ok.status_code == 200
        body = ok.json()
        assert body["access_token"].startswith("fake-at-") and body["refresh_token"].startswith("fake-rt-")
        assert set(body["scope"].split()) >= {"Mail.ReadWrite", "Mail.Send", "offline_access"}
        reused = await exchange(c, code)
        assert reused.status_code == 400 and reused.json()["error"] == "invalid_grant"


async def test_token_refuses_a_wrong_client_secret():
    async with client_for(make_app()) as c:
        resp = await exchange(c, await get_code(c), secret="otro")
    assert resp.status_code == 401 and resp.json()["error"] == "invalid_client"


async def test_refresh_token_rotates():
    async with client_for(make_app()) as c:
        first = await tokens(c)
        resp = await c.post("/common/oauth2/v2.0/token", data={
            "client_id": CLIENT_ID, "client_secret": SECRET, "grant_type": "refresh_token",
            "refresh_token": first["refresh_token"]})
        assert resp.status_code == 200
        second = resp.json()
        assert second["refresh_token"] != first["refresh_token"]
        again = await c.post("/common/oauth2/v2.0/token", data={
            "client_id": CLIENT_ID, "client_secret": SECRET, "grant_type": "refresh_token",
            "refresh_token": first["refresh_token"]})
        assert again.status_code == 400 and again.json()["error"] == "invalid_grant"


async def test_revoke_invalidates_every_token():
    async with client_for(make_app()) as c:
        t = await tokens(c)
        assert (await c.post("/_control/revoke")).json()["revoked"] == 2
        assert (await c.get("/v1.0/me", headers=bearer(t["access_token"]))).status_code == 401
        resp = await c.post("/common/oauth2/v2.0/token", data={
            "client_id": CLIENT_ID, "client_secret": SECRET, "grant_type": "refresh_token",
            "refresh_token": t["refresh_token"]})
        assert resp.json()["error"] == "invalid_grant"


@pytest.mark.parametrize("mode,description", [
    ("consent_denied", "AADSTS65004"), ("admin_consent_required", "AADSTS90094"),
])
async def test_consent_failures_post_an_error_instead_of_a_code(mode, description):
    async with client_for(make_app()) as c:
        await c.post("/_control/fail", params={"mode": mode})
        resp = await c.get("/common/oauth2/v2.0/authorize", params=authorize_params())
        fields = form_fields(resp.text)
        assert "code" not in fields
        assert fields["error"] == "access_denied" and description in fields["error_description"]
        assert fields["state"] == "state-sintetico"
        # times=1: the next one consents again.
        assert "code" in form_fields((await c.get("/common/oauth2/v2.0/authorize", params=authorize_params())).text)


async def test_missing_scope_leaves_out_mail_send():
    async with client_for(make_app()) as c:
        await c.post("/_control/fail", params={"mode": "missing_scope"})
        body = await tokens(c)
    assert "Mail.Send" not in body["scope"].split()


async def test_tokens_lifetime_is_configurable():
    async with client_for(make_app()) as c:
        await c.post("/_control/tokens", params={"expires_in": 60})
        assert (await tokens(c))["expires_in"] == 60


# ── Graph ────────────────────────────────────────────────────────────────────
async def test_me_needs_a_valid_token():
    async with client_for(make_app()) as c:
        assert (await c.get("/v1.0/me", headers=bearer("fake-at-otro"))).status_code == 401
        t = await tokens(c)
        me = (await c.get("/v1.0/me", headers=bearer(t["access_token"]))).json()
    assert me["mail"] == "buzon-prueba@example.test" and me["displayName"] == "Buzón Prueba"


async def test_draft_send_and_read(tmp_path):
    app = make_app(tmp_path)
    async with client_for(app) as c:
        t = await tokens(c)
        h = bearer(t["access_token"])
        draft = await c.post("/v1.0/me/messages", headers=h, json={
            "subject": "Asunto", "body": {"contentType": "Text", "content": "Hola"},
            "toRecipients": [{"emailAddress": {"address": "destino-prueba@example.test"}}]})
        assert draft.status_code == 201
        mid = draft.json()["id"]
        assert draft.json()["internetMessageId"].endswith("@fake-graph.local>")
        assert (await c.get(f"/v1.0/me/messages/{mid}", headers=h)).json()["isDraft"] is True
        assert (await c.post(f"/v1.0/me/messages/{mid}/send", headers=h)).status_code == 202
        assert (await c.get(f"/v1.0/me/messages/{mid}", headers=h)).json()["isDraft"] is False
        assert (await c.post(f"/v1.0/me/messages/{mid}/send", headers=h)).status_code == 400  # never twice
        assert (await c.get("/v1.0/me/messages/fake-msg-nope", headers=h)).status_code == 404
        state = (await c.get("/_control/state")).json()
    assert state["sends"] == 1 and state["sent"] == 1
    log = (tmp_path / "fake.jsonl").read_text(encoding="utf-8")
    assert '"result": "sent"' in log and "destino-prueba@example.test" in log
    # The log never holds a token, a code or the state.
    assert "fake-at-" not in log and "fake-rt-" not in log and "fake-code-" not in log
    assert "state-sintetico" not in log


async def _draft(c, h) -> str:
    resp = await c.post("/v1.0/me/messages", headers=h, json={
        "subject": "S", "body": {"contentType": "Text", "content": "B"},
        "toRecipients": [{"emailAddress": {"address": "destino-prueba@example.test"}}]})
    return resp.json()["id"]


@pytest.mark.parametrize("mode,status,is_draft_after", [
    ("throttled", 429, True), ("send_rejected", 400, True),
    ("send_timeout_sent", 202, False), ("send_timeout_not_sent", 202, True),
])
async def test_send_failure_modes(mode, status, is_draft_after):
    async with client_for(make_app()) as c:
        h = bearer((await tokens(c))["access_token"])
        mid = await _draft(c, h)
        await c.post("/_control/fail", params={"mode": mode})
        resp = await c.post(f"/v1.0/me/messages/{mid}/send", headers=h)
        assert resp.status_code == status
        if mode == "throttled":
            assert resp.headers["retry-after"] == "1"
        assert (await c.get(f"/v1.0/me/messages/{mid}", headers=h)).json()["isDraft"] is is_draft_after


async def test_control_routes_only_from_localhost():
    app = make_app()
    async with client_for(app, host="10.0.0.5") as c:
        for method, path in (("POST", "/_control/fail"), ("POST", "/_control/revoke"), ("POST", "/_control/tokens"),
                             ("GET", "/_control/replay"), ("GET", "/_control/state")):
            assert (await c.request(method, path)).status_code == 403


async def test_replay_reposts_the_last_code_and_state():
    async with client_for(make_app()) as c:
        assert (await c.get("/_control/replay")).status_code == 404
        code = await get_code(c)
        fields = form_fields((await c.get("/_control/replay")).text)
    assert fields == {"code": code, "state": "state-sintetico"}


def test_form_values_are_escaped():
    page = auto_post_form(REDIRECT, {"state": '"><script>alert(1)</script>'})
    assert "<script>alert(1)</script>" not in page
    assert "&quot;&gt;&lt;script&gt;" in page


def test_refuses_any_host_but_localhost():
    with pytest.raises(SystemExit):
        create_app(Config(client_id=CLIENT_ID, client_secret=SECRET, redirect_uri=REDIRECT, host="0.0.0.0"))


def test_main_runs_on_localhost_without_access_log(monkeypatch):
    """The access log would write /authorize's query (state, challenge)."""
    import uvicorn

    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: calls.append(kwargs))
    monkeypatch.setenv("FAKE_GRAPH_CLIENT_SECRET", SECRET)
    monkeypatch.setattr(sys, "argv", ["fake_graph.py", "--client-id", CLIENT_ID, "--redirect-uri", REDIRECT])
    fake_graph.main()
    assert calls == [{"host": "127.0.0.1", "port": 8765, "log_level": "info", "access_log": False}]


def test_imports_no_network_client():
    tree = ast.parse(Path(fake_graph.__file__).read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
    forbidden = {"httpx", "requests", "aiohttp", "urllib.request", "http.client", "smtplib", "aiosmtplib",
                 "socket", "ssl", "urllib3"}
    assert not {name for name in imported if name.split(".")[0] in forbidden or name in forbidden}


# ── the real graph_client against the fake ───────────────────────────────────
async def test_graph_client_works_against_the_fake(monkeypatch):
    s = graph_client.settings
    monkeypatch.setattr(s, "app_env", "development")
    monkeypatch.setattr(s, "mail_allow_custom_endpoints", True)
    monkeypatch.setattr(s, "microsoft_login_base_url", BASE)
    monkeypatch.setattr(s, "graph_base_url", f"{BASE}/v1.0")
    monkeypatch.setattr(s, "mail_oauth_client_id", CLIENT_ID)
    monkeypatch.setattr(s, "mail_oauth_client_secret", SECRET)
    monkeypatch.setattr(s, "mail_oauth_redirect_url", REDIRECT)
    app = make_app()
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
    with patch.object(graph_client, "_new_client", lambda: httpx.AsyncClient(transport=transport)):
        url = graph_client.authorize_url("state-sintetico", graph_client.code_challenge(VERIFIER))
        assert url.startswith(f"{BASE}/common/oauth2/v2.0/authorize?")
        async with httpx.AsyncClient(transport=transport) as browser:
            code = form_fields((await browser.get(url)).text)["code"]
        first = await graph_client.exchange_code(code, VERIFIER)
        assert {"Mail.ReadWrite", "Mail.Send"} <= set(first.scopes)
        me = await graph_client.get_me(first.access_token)
        assert me["address"] == "buzon-prueba@example.test"
        second = await graph_client.refresh(first.refresh_token)
        assert second.refresh_token != first.refresh_token
        ids = await graph_client.create_draft(second.access_token, "Asunto", "Cuerpo", "destino-prueba@example.test")
        assert ids["id"].startswith("fake-msg-") and ids["internet_message_id"]
        assert app.state.graph.messages[ids["id"]]["immutable_id_requested"] is True
        await graph_client.send_draft(second.access_token, ids["id"])
        state = await graph_client.get_message_state(second.access_token, ids["id"])
        assert state["is_draft"] is False and state["internet_message_id"] == ids["internet_message_id"]
        assert await graph_client.get_message_state(second.access_token, "fake-msg-nope") is None
        # A revoked refresh token means «reconnect», as with Microsoft.
        async with httpx.AsyncClient(transport=transport) as ctl:
            await ctl.post(f"{BASE}/_control/revoke")
        with pytest.raises(graph_client.GraphError) as exc:
            await graph_client.refresh(second.refresh_token)
        assert exc.value.code == "mailbox_reconnect_required"
