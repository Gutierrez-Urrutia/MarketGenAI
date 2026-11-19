"""In-process stand-in for Google's token endpoint, OpenID userinfo and the Gmail drafts API, for the Gmail
connection and send tests: gmail_client's HTTP client is replaced by one over an httpx.MockTransport, so no request
ever leaves the process. Synthetic data only (example.test); every token it issues starts with "fake-".

    with FakeGoogle() as g:
        g.token_replies.append((400, {"error": "invalid_grant"}))   # next /token call
        g.userinfo = (200, {...})                                    # every userinfo call
        g.next["send"].append(httpx.ReadTimeout("t"))                # next send fails
        g.next["send"].append(SENT_THEN_TIMEOUT)                     # goes out, then the line drops
        g.calls_to("/token")                                         # what was sent
        g.drafts / g.sent                                            # drafts it holds / messages that went out

Gmail behaviour that matters: sending a draft removes it (GET on it is then a 404), so "sent" and "deleted" look
the same from outside.
"""
from __future__ import annotations

import base64
import json
from email import message_from_bytes, policy
from typing import Any, Dict, List, Optional, Tuple
from unittest.mock import patch
from urllib.parse import parse_qs, unquote

import httpx

from app.core.pipeline_constants import MAIL_GOOGLE_SCOPES
from app.services import gmail_client

Reply = Tuple[int, Any]

USERINFO = {"sub": "fake-google-sub", "email": "ventas@example.test", "name": "Equipo Ventas", "email_verified": True}
SENT_THEN_TIMEOUT = "sent_then_timeout"
SENT_THEN_500 = "sent_then_500"


def decode_raw(raw: str):
    """The email.message of a base64url `raw` as Gmail receives it."""
    padded = raw + "=" * (-len(raw) % 4)
    return message_from_bytes(base64.urlsafe_b64decode(padded), policy=policy.default)


class FakeGoogle:
    def __init__(self):
        self.calls: List[Dict[str, Any]] = []
        self.token_replies: List[Any] = []
        self.userinfo: Reply = (200, dict(USERINFO))
        self.fail_with: Optional[Exception] = None
        self.issued = 0
        self.granted_scopes = " ".join(MAIL_GOOGLE_SCOPES)
        self.drafts: Dict[str, Dict[str, Any]] = {}
        self.sent: List[Dict[str, Any]] = []
        self.next: Dict[str, List[Any]] = {"draft": [], "send": [], "read": []}
        self.created = 0
        self._patch = None

    def success(self, with_refresh: bool = True) -> Dict[str, Any]:
        self.issued += 1
        body = {
            "token_type": "Bearer", "expires_in": 3599, "scope": self.granted_scopes,
            "access_token": f"fake-access-token-{self.issued}",
        }
        if with_refresh:
            body["refresh_token"] = f"fake-refresh-token-{self.issued}"
        return body

    # -- transport --------------------------------------------------------------------------------------------
    async def handler(self, request: httpx.Request) -> httpx.Response:
        raw_path = request.url.raw_path.decode("ascii").split("?", 1)[0]
        path = unquote(raw_path)
        content_type = request.headers.get("content-type", "")
        form: Dict[str, str] = {}
        body: Any = None
        if request.content and "application/json" in content_type:
            body = json.loads(request.content.decode("utf-8"))
        elif request.content:
            form = {k: v[0] for k, v in parse_qs(request.content.decode("utf-8")).items()}
        self.calls.append({
            "method": request.method, "host": request.url.host, "path": path, "raw_path": raw_path,
            "form": form, "json": body, "params": dict(request.url.params), "headers": dict(request.headers),
        })
        if self.fail_with is not None:
            raise self.fail_with
        if request.url.host == "oauth2.googleapis.com" and path == "/token":
            reply = self.token_replies.pop(0) if self.token_replies else (200, self.success())
            return self._response(reply)
        if request.url.host == "openidconnect.googleapis.com" and path == "/v1/userinfo":
            return self._response(self.userinfo)
        base = "/gmail/v1/users/me/drafts"
        if request.url.host == "gmail.googleapis.com" and path.startswith(base):
            rest = path[len(base):]
            if request.method == "POST" and rest == "":
                return self._create(body or {})
            if request.method == "POST" and rest == "/send":
                return self._send((body or {}).get("id", ""))
            if request.method == "GET" and rest.startswith("/"):
                return self._read(rest[1:])
        return httpx.Response(404, json={"error": {"code": 404, "errors": [{"reason": "notFound"}]}})

    def _planned(self, operation: str):
        queue = self.next[operation]
        if not queue:
            return None
        planned = queue.pop(0)
        if isinstance(planned, BaseException):
            raise planned
        return planned

    def _create(self, payload: Dict[str, Any]) -> httpx.Response:
        planned = self._planned("draft")
        if planned is not None:
            return self._response(planned)
        self.created += 1
        draft_id = f"r-fake/draft+{self.created}="  # characters that must be escaped in a URL path
        message = {"id": f"fake-message-{self.created}", "threadId": f"fake-thread-{self.created}"}
        self.drafts[draft_id] = {"raw": payload.get("message", {}).get("raw", ""), "message": message}
        return httpx.Response(200, json={"id": draft_id, "message": message})

    def _send(self, draft_id: str) -> httpx.Response:
        planned = self._planned("send")
        if planned in (SENT_THEN_TIMEOUT, SENT_THEN_500):
            self._deliver(draft_id)
            if planned == SENT_THEN_TIMEOUT:
                raise httpx.ReadTimeout("the answer was lost")
            return httpx.Response(500, json={"error": {"code": 500}})
        if planned is not None:
            return self._response(planned)
        if draft_id not in self.drafts:
            return httpx.Response(404, json={"error": {"code": 404, "errors": [{"reason": "notFound"}]}})
        message = self._deliver(draft_id)
        return httpx.Response(200, json={**message, "labelIds": ["SENT"]})

    def _deliver(self, draft_id: str) -> Dict[str, Any]:
        draft = self.drafts.pop(draft_id, None)
        if draft is None:
            return {}
        self.sent.append(draft)
        return draft["message"]

    def _read(self, draft_id: str) -> httpx.Response:
        planned = self._planned("read")
        if planned is not None:
            return self._response(planned)
        draft = self.drafts.get(draft_id)
        if draft is None:
            return httpx.Response(404, json={"error": {"code": 404, "errors": [{"reason": "notFound"}]}})
        return httpx.Response(200, json={"id": draft_id, "message": draft["message"]})

    @staticmethod
    def _response(reply) -> httpx.Response:
        status, body = reply[0], reply[1]
        headers = reply[2] if len(reply) > 2 else {}
        if isinstance(body, (dict, list)):
            return httpx.Response(status, json=body, headers=headers)
        return httpx.Response(status, text=str(body), headers=headers)

    # -- what happened ----------------------------------------------------------------------------------------
    def calls_to(self, suffix: str) -> List[Dict[str, Any]]:
        return [c for c in self.calls if c["path"].endswith(suffix)]

    def drafts_created(self) -> List[Dict[str, Any]]:
        return [c for c in self.calls if c["method"] == "POST" and c["path"].endswith("/drafts")]

    def sends(self) -> List[Dict[str, Any]]:
        return [c for c in self.calls if c["method"] == "POST" and c["path"].endswith("/drafts/send")]

    def reads(self) -> List[Dict[str, Any]]:
        return [c for c in self.calls if c["method"] == "GET" and "/drafts/" in c["path"]]

    def __enter__(self) -> "FakeGoogle":
        transport = httpx.MockTransport(self.handler)
        self._patch = patch.object(
            gmail_client, "_new_client",
            lambda: httpx.AsyncClient(transport=transport, follow_redirects=False),
        )
        self._patch.start()
        return self

    def __exit__(self, *exc) -> None:
        self._patch.stop()
