"""Local fake of the Microsoft identity platform and Microsoft Graph, for
development and the end-to-end test of the sending mailbox (RF-VTA-16).

It implements only what app/services/graph_client.py calls:

  GET  /common/oauth2/v2.0/authorize    consents at once and makes the BROWSER
                                        POST code + state to the redirect URI
                                        (form_post), like Microsoft
  POST /common/oauth2/v2.0/token        authorization_code (PKCE S256) and
                                        refresh_token (rotated on every use)
  GET  /v1.0/me                         the fake mailbox
  POST /v1.0/me/messages                create a draft (immutable id)
  POST /v1.0/me/messages/{id}/send      "send" the draft: it is only marked as
                                        sent here and written to the log
  GET  /v1.0/me/messages/{id}           isDraft / internetMessageId / conversationId

Control routes (only from 127.0.0.1), to make it fail on purpose:

  POST /_control/fail?mode=<mode>&times=<n>   n=0: until changed. Modes:
       consent_denied, admin_consent_required, missing_scope, throttled,
       send_rejected, send_timeout_sent, send_timeout_not_sent, none
  POST /_control/revoke                       every issued token stops working
  POST /_control/tokens?expires_in=<s>        lifetime of the next tokens
  GET  /_control/replay                       re-POSTs the last code + state to
                                              the callback (reused state)
  GET  /_control/state                        counts and mode; never a token

It NEVER sends anything anywhere: it imports no network client (no httpx,
requests, urllib.request, smtplib, socket…), listens on 127.0.0.1 only and
keeps every message in memory. The only thing that leaves it is the HTML page
of /authorize, which the browser posts to the configured redirect URI.

The log (JSON lines, --log) never holds a code, a state or a token: at most
the first 8 hex characters of its sha256.

Usage (from backend/):

    set FAKE_GRAPH_CLIENT_SECRET=<synthetic secret, the same as MAIL_OAUTH_CLIENT_SECRET>
    python -I scripts/dev/fake_graph.py --port 8765 \
        --client-id 00000000-0000-0000-0000-000000000000 \
        --redirect-uri http://localhost:8000/api/v1/mail-connection/callback \
        --slow-seconds 6 --log <path outside the repo>

and point the backend at it: MICROSOFT_LOGIN_BASE_URL=http://127.0.0.1:8765,
GRAPH_BASE_URL=http://127.0.0.1:8765/v1.0, MAIL_ALLOW_CUSTOM_ENDPOINTS=true
(refused when APP_ENV=production).
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import html
import json
import os
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Set

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

HOST = "127.0.0.1"
FAIL_MODES = {
    "none", "consent_denied", "admin_consent_required", "missing_scope",
    "throttled", "send_rejected", "send_timeout_sent", "send_timeout_not_sent",
}
SCOPES = ("openid", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send")
MAILBOX = {
    "id": "fake-user-0001",
    "displayName": "Buzón Prueba",
    "mail": "buzon-prueba@example.test",
    "userPrincipalName": "buzon-prueba@example.test",
}


def short_hash(value: str) -> str:
    """First 8 hex characters of sha256: enough to tell values apart in the
    log, never the value itself."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]


def s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def auto_post_form(action: str, fields: Dict[str, str]) -> str:
    """The page that makes the browser POST `fields` to `action` (form_post).
    Every value is HTML-escaped."""
    inputs = "".join(
        f'<input type="hidden" name="{html.escape(k, quote=True)}" value="{html.escape(v, quote=True)}">'
        for k, v in fields.items()
    )
    return (
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Fake Graph</title></head><body>"
        f'<form id="f" method="post" action="{html.escape(action, quote=True)}">{inputs}'
        "<noscript><button type=\"submit\">Continue</button></noscript></form>"
        "<script>document.getElementById('f').submit();</script></body></html>"
    )


@dataclass
class Config:
    client_id: str
    client_secret: str
    redirect_uri: str
    log_path: Optional[Path] = None
    slow_seconds: float = 6.0
    host: str = HOST


@dataclass
class FakeGraph:
    """All the state, in memory."""

    cfg: Config
    codes: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    access: Set[str] = field(default_factory=set)
    refresh: Set[str] = field(default_factory=set)
    expires_in: int = 3600
    messages: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    fail: str = "none"
    fail_times: int = 0
    last_form: Optional[Dict[str, str]] = None
    sends: int = 0

    def take(self, *modes: str) -> Optional[str]:
        """The current failure mode if it is one of `modes` (and uses one of
        its remaining times), else None."""
        if self.fail not in modes:
            return None
        mode = self.fail
        if self.fail_times > 0:
            self.fail_times -= 1
            if self.fail_times == 0:
                self.fail = "none"
        return mode

    def log(self, **event: Any) -> None:
        if not self.cfg.log_path:
            return
        row = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **event}
        self.cfg.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.cfg.log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    def issue_tokens(self, scopes=SCOPES) -> Dict[str, Any]:
        access, refresh = f"fake-at-{secrets.token_hex(16)}", f"fake-rt-{secrets.token_hex(16)}"
        self.access.add(access)
        self.refresh.add(refresh)
        return {
            "token_type": "Bearer", "access_token": access, "refresh_token": refresh,
            "expires_in": self.expires_in, "scope": " ".join(scopes),
        }


def _oauth_error(status: int, error: str) -> JSONResponse:
    return JSONResponse({"error": error, "error_description": f"fake graph: {error}"}, status_code=status)


def _graph_error(status: int, code: str, headers: Optional[Dict[str, str]] = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": f"fake graph: {code}"}}, status_code=status, headers=headers)


def create_app(cfg: Config) -> FastAPI:
    if cfg.host != HOST:
        raise SystemExit(f"fake_graph only listens on {HOST}")
    app = FastAPI(title="Fake Microsoft Graph (local)", docs_url=None, redoc_url=None, openapi_url=None)
    g = FakeGraph(cfg)
    app.state.graph = g

    def authorized(request: Request) -> bool:
        auth = request.headers.get("authorization", "")
        return auth.startswith("Bearer ") and auth[len("Bearer "):] in g.access

    def from_localhost(request: Request) -> bool:
        return bool(request.client) and request.client.host == HOST

    # ── identity platform ───────────────────────────────────────────────────
    @app.get("/common/oauth2/v2.0/authorize")
    async def authorize(request: Request):
        q = request.query_params
        problems = [
            name for name, ok in (
                ("client_id", q.get("client_id") == cfg.client_id),
                ("redirect_uri", q.get("redirect_uri") == cfg.redirect_uri),
                ("response_type", q.get("response_type") == "code"),
                ("response_mode", q.get("response_mode") == "form_post"),
                ("code_challenge_method", q.get("code_challenge_method") == "S256"),
                ("code_challenge", bool(q.get("code_challenge"))),
                ("state", bool(q.get("state"))),
            ) if not ok
        ]
        if problems:
            g.log(route="authorize", result="bad_request", fields=problems)
            return HTMLResponse(f"<p>Fake Graph: invalid request ({html.escape(', '.join(problems))}).</p>", 400)
        state = q["state"]
        mode = g.take("consent_denied", "admin_consent_required")
        if mode == "consent_denied":
            fields = {"error": "access_denied", "error_description": "AADSTS65004: User declined to consent (fake).",
                      "state": state}
        elif mode == "admin_consent_required":
            fields = {"error": "access_denied", "error_description": "AADSTS90094: Admin approval required (fake).",
                      "state": state}
        else:
            code = f"fake-code-{secrets.token_hex(16)}"
            g.codes[code] = {"challenge": q["code_challenge"], "redirect_uri": q["redirect_uri"], "used": False}
            fields = {"code": code, "state": state}
        g.last_form = dict(fields)
        g.log(route="authorize", result=mode or "consented", state=short_hash(state))
        return HTMLResponse(auto_post_form(cfg.redirect_uri, fields))

    @app.post("/common/oauth2/v2.0/token")
    async def token(request: Request):
        form = await request.form()
        if form.get("client_id") != cfg.client_id or form.get("client_secret") != cfg.client_secret:
            g.log(route="token", result="invalid_client")
            return _oauth_error(401, "invalid_client")
        grant = form.get("grant_type")
        if grant == "authorization_code":
            code = str(form.get("code") or "")
            pending = g.codes.get(code)
            if (not pending or pending["used"] or form.get("redirect_uri") != pending["redirect_uri"]
                    or s256(str(form.get("code_verifier") or "")) != pending["challenge"]):
                g.log(route="token", grant=grant, result="invalid_grant", code=short_hash(code))
                return _oauth_error(400, "invalid_grant")
            pending["used"] = True
            scopes = tuple(s for s in SCOPES if s != "Mail.Send") if g.take("missing_scope") else SCOPES
            body = g.issue_tokens(scopes)
            g.log(route="token", grant=grant, result="ok", code=short_hash(code), refresh=short_hash(body["refresh_token"]))
            return JSONResponse(body)
        if grant == "refresh_token":
            old = str(form.get("refresh_token") or "")
            if old not in g.refresh:
                g.log(route="token", grant=grant, result="invalid_grant", refresh=short_hash(old))
                return _oauth_error(400, "invalid_grant")
            g.refresh.discard(old)  # rotation: the old one never works again
            body = g.issue_tokens()
            g.log(route="token", grant=grant, result="ok", refresh_old=short_hash(old),
                  refresh_new=short_hash(body["refresh_token"]))
            return JSONResponse(body)
        g.log(route="token", result="unsupported_grant_type")
        return _oauth_error(400, "unsupported_grant_type")

    # ── Graph ───────────────────────────────────────────────────────────────
    @app.get("/v1.0/me")
    async def me(request: Request):
        if not authorized(request):
            g.log(route="me", result="401")
            return _graph_error(401, "InvalidAuthenticationToken")
        g.log(route="me", result="ok")
        return JSONResponse(dict(MAILBOX))

    @app.post("/v1.0/me/messages")
    async def create_message(request: Request):
        if not authorized(request):
            g.log(route="create_message", result="401")
            return _graph_error(401, "InvalidAuthenticationToken")
        if g.take("throttled"):
            g.log(route="create_message", result="429")
            return _graph_error(429, "ApplicationThrottled", {"Retry-After": "1"})
        payload = await request.json()
        to = [r.get("emailAddress", {}).get("address", "") for r in payload.get("toRecipients") or []]
        hex_id = secrets.token_hex(8)
        message_id = f"fake-msg-{hex_id}"
        g.messages[message_id] = {
            "isDraft": True,
            "internetMessageId": f"<fake-{hex_id}@fake-graph.local>",
            "conversationId": f"fake-conv-{hex_id}",
            "to": to, "subject": str(payload.get("subject") or ""),
            "immutable_id_requested": 'IdType="ImmutableId"' in request.headers.get("prefer", ""),
        }
        msg = g.messages[message_id]
        g.log(route="create_message", result="201", message_id=message_id, to=to, subject=msg["subject"],
              immutable_id=msg["immutable_id_requested"])
        return JSONResponse({"id": message_id, "isDraft": True, "internetMessageId": msg["internetMessageId"],
                             "conversationId": msg["conversationId"]}, status_code=201)

    @app.post("/v1.0/me/messages/{message_id}/send")
    async def send_message(message_id: str, request: Request):
        if not authorized(request):
            g.log(route="send", result="401", message_id=message_id)
            return _graph_error(401, "InvalidAuthenticationToken")
        msg = g.messages.get(message_id)
        if not msg:
            g.log(route="send", result="404", message_id=message_id)
            return _graph_error(404, "ErrorItemNotFound")
        if not msg["isDraft"]:
            g.log(route="send", result="400_already_sent", message_id=message_id)
            return _graph_error(400, "ErrorInvalidRequest")
        mode = g.take("throttled", "send_rejected", "send_timeout_sent", "send_timeout_not_sent")
        if mode == "throttled":
            g.log(route="send", result="429", message_id=message_id)
            return _graph_error(429, "ApplicationThrottled", {"Retry-After": "1"})
        if mode == "send_rejected":
            g.log(route="send", result="400_rejected", message_id=message_id)
            return _graph_error(400, "ErrorMessageSubmissionBlocked")
        if mode != "send_timeout_not_sent":
            msg["isDraft"] = False  # "sent": nothing leaves this process
            g.sends += 1
            g.log(route="send", result="sent", message_id=message_id, to=msg["to"], subject=msg["subject"],
                  internet_message_id=msg["internetMessageId"], mode=mode or "none")
        if mode in ("send_timeout_sent", "send_timeout_not_sent"):
            if mode == "send_timeout_not_sent":
                g.log(route="send", result="timeout_not_sent", message_id=message_id)
            await asyncio.sleep(cfg.slow_seconds)  # longer than the backend's timeout
        return Response(status_code=202)

    @app.get("/v1.0/me/messages/{message_id}")
    async def get_message(message_id: str, request: Request):
        if not authorized(request):
            g.log(route="get_message", result="401", message_id=message_id)
            return _graph_error(401, "InvalidAuthenticationToken")
        msg = g.messages.get(message_id)
        if not msg:
            g.log(route="get_message", result="404", message_id=message_id)
            return _graph_error(404, "ErrorItemNotFound")
        g.log(route="get_message", result="ok", message_id=message_id, is_draft=msg["isDraft"])
        return JSONResponse({"id": message_id, "isDraft": msg["isDraft"],
                             "internetMessageId": msg["internetMessageId"], "conversationId": msg["conversationId"]})

    # ── control ─────────────────────────────────────────────────────────────
    @app.post("/_control/fail")
    async def control_fail(request: Request, mode: str = "none", times: int = 1):
        if not from_localhost(request):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        if mode not in FAIL_MODES or times < 0:
            return JSONResponse({"error": "unknown mode", "modes": sorted(FAIL_MODES)}, status_code=400)
        g.fail, g.fail_times = mode, (0 if mode == "none" else times)
        g.log(route="_control/fail", mode=mode, times=times)
        return {"mode": g.fail, "times": g.fail_times}

    @app.post("/_control/revoke")
    async def control_revoke(request: Request):
        if not from_localhost(request):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        revoked = len(g.access) + len(g.refresh)
        g.access.clear()
        g.refresh.clear()
        g.log(route="_control/revoke", revoked=revoked)
        return {"revoked": revoked}

    @app.post("/_control/tokens")
    async def control_tokens(request: Request, expires_in: int = 3600):
        if not from_localhost(request):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        g.expires_in = max(1, expires_in)
        g.log(route="_control/tokens", expires_in=g.expires_in)
        return {"expires_in": g.expires_in}

    @app.get("/_control/replay")
    async def control_replay(request: Request):
        if not from_localhost(request):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        if not g.last_form:
            return HTMLResponse("<p>Fake Graph: nothing to replay yet.</p>", 404)
        g.log(route="_control/replay", state=short_hash(g.last_form.get("state", "")))
        return HTMLResponse(auto_post_form(cfg.redirect_uri, g.last_form))

    @app.get("/_control/state")
    async def control_state(request: Request):
        if not from_localhost(request):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return {
            "mode": g.fail, "times": g.fail_times, "expires_in": g.expires_in,
            "codes": len(g.codes), "access_tokens": len(g.access), "refresh_tokens": len(g.refresh),
            "drafts": sum(1 for m in g.messages.values() if m["isDraft"]),
            "sent": sum(1 for m in g.messages.values() if not m["isDraft"]), "sends": g.sends,
        }

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Local fake Microsoft Graph (never sends anything).")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--redirect-uri", required=True)
    parser.add_argument("--slow-seconds", type=float, default=6.0)
    parser.add_argument("--log", type=Path, default=None)
    args = parser.parse_args()
    secret = os.environ.get("FAKE_GRAPH_CLIENT_SECRET", "")
    if not secret:
        raise SystemExit("FAKE_GRAPH_CLIENT_SECRET is not set (use a synthetic value).")
    import uvicorn  # the server only; it opens no outgoing connection

    app = create_app(Config(client_id=args.client_id, client_secret=secret, redirect_uri=args.redirect_uri,
                            log_path=args.log, slow_seconds=args.slow_seconds))
    # No access log: /authorize carries the OAuth state and the PKCE challenge
    # in its query string, and they must never be written anywhere.
    uvicorn.run(app, host=HOST, port=args.port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
