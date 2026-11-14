"""In-process stand-in for Microsoft's login endpoint and Graph, for the
mailbox-connection tests: graph_client's HTTP client is replaced by one over
an httpx.MockTransport, so no request ever leaves the process. Synthetic data
only (example.test); every token it issues starts with "fake-".

    with FakeMicrosoft() as ms:
        ms.token_replies.append((400, {"error": "invalid_grant"}))   # next /token call
        ms.me = (200, {...})                                          # every /me call
        ...
        ms.calls_to("/token")   # what was sent
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import httpx

from app.core.pipeline_constants import MAIL_OAUTH_SCOPES
from app.services import graph_client

Reply = Tuple[int, Any]

ME = {
    "id": "fake-account-id", "displayName": "Equipo Ventas", "mail": "ventas@example.test",
    "userPrincipalName": "ventas@example.test",
}


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
    def handler(self, request: httpx.Request) -> httpx.Response:
        form = {k: v[0] for k, v in parse_qs(request.content.decode("utf-8")).items()} if request.content else {}
        self.calls.append({
            "method": request.method, "url": str(request.url), "path": request.url.path,
            "form": form, "params": dict(request.url.params), "headers": dict(request.headers),
        })
        if self.fail_with is not None:
            raise self.fail_with
        if request.url.path.endswith("/oauth2/v2.0/token"):
            if self.on_token:
                self.on_token()
            reply = self.token_replies.pop(0) if self.token_replies else (200, self.success())
            return self._response(reply)
        if request.url.path.endswith("/me"):
            return self._response(self.me)
        return httpx.Response(404, json={"error": {"code": "NotFound"}})

    @staticmethod
    def _response(reply) -> httpx.Response:
        status, body = reply[0], reply[1]
        headers = reply[2] if len(reply) > 2 else {}
        if isinstance(body, (dict, list)):
            return httpx.Response(status, json=body, headers=headers)
        return httpx.Response(status, text=str(body), headers=headers)

    def calls_to(self, suffix: str) -> List[Dict[str, Any]]:
        return [c for c in self.calls if c["path"].endswith(suffix)]

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
