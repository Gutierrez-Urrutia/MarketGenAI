"""In-process stand-in for Microsoft's login endpoint and Graph, for the
mailbox-connection and send tests: graph_client's HTTP client is replaced by
one over an httpx.MockTransport, so no request ever leaves the process.
Synthetic data only (example.test); every token it issues starts with "fake-".

    with FakeMicrosoft() as ms:
        ms.token_replies.append((400, {"error": "invalid_grant"}))   # next /token call
        ms.me = (200, {...})                                          # every /me call
        ms.next["send"].append(httpx.ReadTimeout("t"))                # next send fails
        ms.next["send"].append(SENT_THEN_TIMEOUT)                     # goes out, then the line drops
        ...
        ms.calls_to("/token")   # what was sent
        ms.messages             # drafts / sent messages it holds, by id

Messages: POST /me/messages creates a draft (isDraft true), POST
/me/messages/{id}/send sends it (isDraft false, 202), GET /me/messages/{id}
reads it (404 when it does not exist). Ids are "immutable" (they never change).
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from app.core.pipeline_constants import MAIL_OAUTH_SCOPES
from app.services import graph_client

Reply = Tuple[int, Any]

ME = {
    "id": "fake-account-id", "displayName": "Equipo Ventas", "mail": "ventas@example.test",
    "userPrincipalName": "ventas@example.test",
}
# For ms.next["send"]: the message really goes out, then the answer is lost.
SENT_THEN_TIMEOUT = "sent_then_timeout"
SENT_THEN_500 = "sent_then_500"


class FakeMicrosoft:
    def __init__(self):
        self.calls: List[Dict[str, Any]] = []
        # Replies for the next /token calls, in order; when empty, a success.
        self.token_replies: List[Any] = []
        self.me: Reply = (200, dict(ME))
        # Raised instead of answering (e.g. httpx.ReadTimeout), for every call.
        self.fail_with: Optional[Exception] = None
        # Called on each /token request before answering (e.g. to simulate a
        # concurrent refresh changing the stored connection).
        self.on_token: Optional[Callable[[], None]] = None
        self.issued = 0
        self.granted_scopes = " ".join(MAIL_OAUTH_SCOPES)
        # Messages it holds, by id, and what the next message calls do instead
        # of succeeding: an exception (raised), a reply tuple (answered as is,
        # nothing changes), or SENT_THEN_* (send only).
        self.messages: Dict[str, Dict[str, Any]] = {}
        self.next: Dict[str, List[Any]] = {"draft": [], "send": [], "read": []}
        # An asyncio.Event: hold every send until it is set.
        self.send_gate: Optional[asyncio.Event] = None
        self.drafted = 0
        self._patch = None

    # ── tokens it hands out ──────────────────────────────────────────────────
    def success(self, with_refresh: bool = True) -> Dict[str, Any]:
        self.issued += 1
        body = {
            "token_type": "Bearer", "expires_in": 3600, "scope": self.granted_scopes,
            "access_token": f"fake-access-token-{self.issued}",
        }
        if with_refresh:
            body["refresh_token"] = f"fake-refresh-token-{self.issued}"
        return body

    # ── transport ────────────────────────────────────────────────────────────
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
            "method": request.method, "url": str(request.url), "path": path, "raw_path": raw_path,
            "form": form, "json": body, "params": dict(request.url.params), "headers": dict(request.headers),
        })
        if self.fail_with is not None:
            raise self.fail_with
        if path.endswith("/oauth2/v2.0/token"):
            if self.on_token:
                self.on_token()
            reply = self.token_replies.pop(0) if self.token_replies else (200, self.success())
            return self._response(reply)
        if path.endswith("/me"):
            return self._response(self.me)
        marker = "/me/messages"
        if marker in path:
            rest = path.split(marker, 1)[1]
            if request.method == "POST" and rest == "":
                return self._draft(body or {})
            if request.method == "POST" and rest.endswith("/send"):
                return await self._send(rest[1:-len("/send")])
            if request.method == "GET" and rest.startswith("/"):
                return self._read(rest[1:])
        return httpx.Response(404, json={"error": {"code": "NotFound"}})

    def _planned(self, operation: str):
        queue = self.next[operation]
        if not queue:
            return None
        planned = queue.pop(0)
        if isinstance(planned, BaseException):
            raise planned
        return planned

    def _draft(self, payload: Dict[str, Any]) -> httpx.Response:
        planned = self._planned("draft")
        if planned is not None:
            return self._response(planned)
        self.drafted += 1
        # An id with characters that must be escaped in a URL path.
        message_id = f"AAMk-fake/immutable+{self.drafted}=="
        self.messages[message_id] = {
            "id": message_id, "isDraft": True, "payload": payload,
            "internetMessageId": f"<fake-{self.drafted}@example.test>", "conversationId": f"fake-conversation-{self.drafted}",
        }
        return httpx.Response(201, json={**self._public(message_id), "subject": payload.get("subject")})

    async def _send(self, message_id: str) -> httpx.Response:
        if self.send_gate is not None:
            await asyncio.wait_for(self.send_gate.wait(), timeout=5)
        planned = self._planned("send")
        if planned in (SENT_THEN_TIMEOUT, SENT_THEN_500):
            if message_id in self.messages:
                self.messages[message_id]["isDraft"] = False
            if planned == SENT_THEN_TIMEOUT:
                raise httpx.ReadTimeout("the answer was lost")
            return httpx.Response(500, json={"error": {"code": "InternalServerError"}})
        if planned is not None:
            return self._response(planned)
        if message_id not in self.messages:
            return httpx.Response(404, json={"error": {"code": "ErrorItemNotFound"}})
        self.messages[message_id]["isDraft"] = False
        return httpx.Response(202)

    def _read(self, message_id: str) -> httpx.Response:
        planned = self._planned("read")
        if planned is not None:
            return self._response(planned)
        if message_id not in self.messages:
            return httpx.Response(404, json={"error": {"code": "ErrorItemNotFound"}})
        return httpx.Response(200, json=self._public(message_id))

    def _public(self, message_id: str) -> Dict[str, Any]:
        m = self.messages[message_id]
        return {
            "id": m["id"], "isDraft": m["isDraft"], "internetMessageId": m["internetMessageId"],
            "conversationId": m["conversationId"],
        }

    @staticmethod
    def _response(reply) -> httpx.Response:
        status, body = reply[0], reply[1]
        headers = reply[2] if len(reply) > 2 else {}
        if isinstance(body, (dict, list)):
            return httpx.Response(status, json=body, headers=headers)
        return httpx.Response(status, text=str(body), headers=headers)

    # ── what happened ────────────────────────────────────────────────────────
    def calls_to(self, suffix: str) -> List[Dict[str, Any]]:
        return [c for c in self.calls if c["path"].endswith(suffix)]

    def drafts_created(self) -> List[Dict[str, Any]]:
        return [c for c in self.calls if c["method"] == "POST" and c["path"].endswith("/me/messages")]

    def sends(self) -> List[Dict[str, Any]]:
        return [c for c in self.calls if c["method"] == "POST" and c["path"].endswith("/send")]

    def reads(self) -> List[Dict[str, Any]]:
        return [c for c in self.calls if c["method"] == "GET" and "/me/messages/" in c["path"]]

    def sent_messages(self) -> List[Dict[str, Any]]:
        return [m for m in self.messages.values() if not m["isDraft"]]

    def __enter__(self) -> "FakeMicrosoft":
        transport = httpx.MockTransport(self.handler)
        self._patch = patch.object(
            graph_client, "_new_client",
            lambda: httpx.AsyncClient(transport=transport, follow_redirects=False),
        )
        self._patch.start()
        return self

    def __exit__(self, *exc) -> None:
        self._patch.stop()


def query_of(url: str) -> Dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
