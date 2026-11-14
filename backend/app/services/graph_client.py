"""Microsoft identity platform + Microsoft Graph client for the mailbox
connection (RF-VTA-16): each user connects their own Microsoft 365 / Outlook
mailbox with delegated OAuth (authorization code + PKCE).

What it does: build the authorization URL (response_mode=form_post, so the
code never travels in a URL that an access log would keep), exchange the code,
refresh the access token (Microsoft rotates the refresh token: the new one is
returned), read the signed-in user (GET /me), and send a prospecting email as
a draft that is then sent (create_draft → send_draft), so that its ids are
known before it goes out. The only message it ever reads is one the platform
itself created, by the id stored on the email (get_message_state): there is
no listing of the mailbox and no other email's content is read.

Message ids are immutable (Prefer: IdType="ImmutableId"): the id of the draft
stays the same once Microsoft moves it to Sent Items, so reading it later says
whether it went out.

Endpoints: MICROSOFT_LOGIN_BASE_URL and GRAPH_BASE_URL. Anything other than
the official ones (e.g. the local fake Graph) needs MAIL_ALLOW_CUSTOM_ENDPOINTS
and is refused in production (503 mail_endpoints_not_allowed).

Never logs, and never puts in an exception, a token, a code or a response
body: errors carry a code only (GraphError.detail).
"""
from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote, urlencode

import httpx

from app.config import DEFAULT_GRAPH_BASE_URL, DEFAULT_MICROSOFT_LOGIN_BASE_URL, settings
from app.core.pipeline_constants import MAIL_OAUTH_SCOPES

# "common": work or school accounts of any tenant, and personal accounts.
AUTHORITY = "common"
# Token errors after which only a new consent helps (the refresh token was
# revoked or expired, the password changed, consent was withdrawn…).
_RECONNECT_ERRORS = {"invalid_grant", "interaction_required", "consent_required", "login_required"}


class GraphError(Exception):
    """A refusal of the login or Graph endpoint, as a code (never its text).
    `uncertain`: only for send_draft — the request may have been accepted
    (a timeout or server error after it was sent), so the email may be out."""

    def __init__(self, status_code: int, code: str, *, uncertain: bool = False, **extra: Any):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.uncertain = uncertain
        self.extra = extra

    @property
    def detail(self) -> Dict[str, Any]:
        return {"code": self.code, **self.extra}


@dataclass(frozen=True)
class TokenSet:
    access_token: str
    refresh_token: str
    expires_in: int
    scopes: Tuple[str, ...]

    def __repr__(self) -> str:  # never print the tokens
        return f"TokenSet(expires_in={self.expires_in}, scopes={self.scopes})"


# ── PKCE ─────────────────────────────────────────────────────────────────────
def new_code_verifier() -> str:
    """A PKCE code verifier: 86 URL-safe characters (RFC 7636 allows 43–128)."""
    return secrets.token_urlsafe(64)


def code_challenge(verifier: str) -> str:
    """S256 challenge of `verifier`: base64url(sha256), without padding."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


# ── Configuration ────────────────────────────────────────────────────────────
def oauth_configured() -> bool:
    """Whether the app registration (client id and secret) is set."""
    return bool(settings.mail_oauth_client_id.strip() and settings.mail_oauth_client_secret.strip())


def endpoints() -> Tuple[str, str]:
    """(login base URL, Graph base URL), after the custom-endpoint guard."""
    login = settings.microsoft_login_base_url.strip().rstrip("/")
    graph = settings.graph_base_url.strip().rstrip("/")
    custom = login != DEFAULT_MICROSOFT_LOGIN_BASE_URL or graph != DEFAULT_GRAPH_BASE_URL
    if custom and (settings.app_env.lower() == "production" or not settings.mail_allow_custom_endpoints):
        raise GraphError(503, "mail_endpoints_not_allowed")
    return login, graph


def authorize_url(state: str, challenge: str) -> str:
    """Where the browser goes to consent. The answer comes back as a POST
    (form_post) to MAIL_OAUTH_REDIRECT_URL with `code` and `state`."""
    login, _ = endpoints()
    params = {
        "client_id": settings.mail_oauth_client_id.strip(),
        "response_type": "code",
        "response_mode": "form_post",
        "redirect_uri": settings.mail_oauth_redirect_url.strip(),
        "scope": " ".join(MAIL_OAUTH_SCOPES),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    return f"{login}/{AUTHORITY}/oauth2/v2.0/authorize?{urlencode(params)}"


# ── HTTP ─────────────────────────────────────────────────────────────────────
def _new_client() -> httpx.AsyncClient:
    """One client per call. Redirects are never followed. Tests replace this."""
    return httpx.AsyncClient(timeout=settings.mail_http_timeout_seconds, follow_redirects=False)


def _json(resp: httpx.Response) -> Dict[str, Any]:
    try:
        body = resp.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _retry_after(resp: httpx.Response) -> Optional[int]:
    try:
        return max(0, int(resp.headers.get("Retry-After", "")))
    except ValueError:
        return None


def _transport_failure(resp: httpx.Response) -> Optional[GraphError]:
    """Throttling or a server-side failure, for any endpoint."""
    if resp.status_code == 429:
        retry_after = _retry_after(resp)
        return GraphError(503, "mail_throttled", **({"retry_after": retry_after} if retry_after is not None else {}))
    if resp.status_code >= 500:
        return GraphError(502, "mail_service_unavailable")
    return None


async def _send(method: str, url: str, *, uncertain_once_sent: bool = False, **kwargs: Any) -> httpx.Response:
    """One HTTP call. With `uncertain_once_sent` (send_draft), a failure after
    the connection was made — the request may have reached Microsoft — is
    504 send_timeout, uncertain; failing to connect is always safe."""
    try:
        async with _new_client() as client:
            return await client.request(method, url, **kwargs)
    except (httpx.ConnectTimeout, httpx.PoolTimeout):
        raise GraphError(504, "mail_service_timeout") from None
    except httpx.ConnectError:
        raise GraphError(502, "mail_service_unavailable") from None
    except httpx.TimeoutException:
        if uncertain_once_sent:
            raise GraphError(504, "send_timeout", uncertain=True) from None
        raise GraphError(504, "mail_service_timeout") from None
    except httpx.HTTPError:
        if uncertain_once_sent:
            raise GraphError(504, "send_timeout", uncertain=True) from None
        raise GraphError(502, "mail_service_unavailable") from None


def _scope_names(raw: Any) -> Tuple[str, ...]:
    """Granted scopes, without the resource prefix
    ("https://graph.microsoft.com/Mail.Send" → "Mail.Send")."""
    names = []
    for item in str(raw or "").split():
        name = item.rsplit("/", 1)[-1]
        if name and name not in names:
            names.append(name)
    return tuple(names)


async def _token_request(form: Dict[str, str], previous_refresh_token: str = "") -> TokenSet:
    login, _ = endpoints()
    data = {
        "client_id": settings.mail_oauth_client_id.strip(),
        "client_secret": settings.mail_oauth_client_secret.strip(),
        "scope": " ".join(MAIL_OAUTH_SCOPES),
        **form,
    }
    resp = await _send(
        "POST", f"{login}/{AUTHORITY}/oauth2/v2.0/token", data=data, headers={"Accept": "application/json"},
    )
    failure = _transport_failure(resp)
    if failure:
        raise failure
    body = _json(resp)
    if resp.status_code != 200:
        if str(body.get("error") or "") in _RECONNECT_ERRORS:
            raise GraphError(409, "mailbox_reconnect_required")
        raise GraphError(502, "mailbox_auth_failed")
    access_token = body.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise GraphError(502, "mail_service_unavailable")
    refresh_token = body.get("refresh_token")
    if not isinstance(refresh_token, str) or not refresh_token:
        refresh_token = previous_refresh_token
    try:
        expires_in = int(body.get("expires_in") or 3600)
    except (TypeError, ValueError):
        expires_in = 3600
    return TokenSet(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=max(60, expires_in),
        scopes=_scope_names(body.get("scope")),
    )


async def exchange_code(code: str, code_verifier: str) -> TokenSet:
    """Exchange an authorization code (with its PKCE verifier) for tokens.
    The token set may lack a refresh token (offline_access not granted): the
    caller decides."""
    return await _token_request({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.mail_oauth_redirect_url.strip(),
        "code_verifier": code_verifier,
    })


async def refresh(refresh_token: str) -> TokenSet:
    """A new access token. Microsoft usually returns a new refresh token too
    (rotation); when it does not, the current one stays valid and is kept.
    409 mailbox_reconnect_required when only a new consent helps."""
    return await _token_request(
        {"grant_type": "refresh_token", "refresh_token": refresh_token}, previous_refresh_token=refresh_token,
    )


async def get_me(access_token: str) -> Dict[str, str]:
    """The signed-in user's mailbox: {"id", "address", "display_name"}. The
    address is `mail`, or `userPrincipalName` when `mail` is empty (personal
    accounts)."""
    _, graph = endpoints()
    resp = await _send(
        "GET", f"{graph}/me",
        params={"$select": "id,displayName,mail,userPrincipalName"},
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    failure = _transport_failure(resp)
    if failure:
        raise failure
    if resp.status_code == 401:
        raise GraphError(409, "mailbox_reconnect_required")
    if resp.status_code == 403:
        raise GraphError(409, "missing_permissions")
    if resp.status_code != 200:
        raise GraphError(502, "mail_service_unavailable")
    body = _json(resp)
    address = str(body.get("mail") or "").strip() or str(body.get("userPrincipalName") or "").strip()
    if "@" not in address:
        raise GraphError(422, "mailbox_without_address")
    return {
        "id": str(body.get("id") or ""),
        "address": address,
        "display_name": str(body.get("displayName") or "").strip(),
    }


# ── Messages (only the platform's own) ───────────────────────────────────────
def _message_headers(access_token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "Prefer": 'IdType="ImmutableId"',
    }


def _message_url(graph: str, message_id: str, suffix: str = "") -> str:
    return f"{graph}/me/messages/{quote(message_id, safe='')}{suffix}"


def _message_failure(resp: httpx.Response) -> GraphError:
    """A refusal of a message call that sent nothing."""
    failure = _transport_failure(resp)
    if failure:
        return failure
    if resp.status_code == 401:
        return GraphError(409, "mailbox_reconnect_required")
    if resp.status_code == 403:
        return GraphError(409, "missing_permissions")
    # 400 / 404 / 413 / 422…: Graph refused this message (bad recipient,
    # too large, mailbox not enabled for mail…).
    return GraphError(502, "mail_rejected")


def _single_line(value: Any) -> str:
    """A subject with no line breaks. Pure."""
    return " ".join(str(value or "").split())


def draft_payload(subject: Any, body_text: str, to_address: str) -> Dict[str, Any]:
    """The draft of one prospecting email: plain text, one recipient. The
    sender is the signed-in mailbox itself. Pure."""
    return {
        "subject": _single_line(subject),
        "body": {"contentType": "Text", "content": body_text},
        "toRecipients": [{"emailAddress": {"address": to_address}}],
    }


async def create_draft(access_token: str, subject: Any, body_text: str, to_address: str) -> Dict[str, str]:
    """Create the email as a draft in the user's mailbox. Nothing is sent.
    Returns {"id" (immutable), "internet_message_id", "conversation_id"}.
    Any failure here is safe: at most an unsent draft is left."""
    _, graph = endpoints()
    resp = await _send(
        "POST", f"{graph}/me/messages",
        json=draft_payload(subject, body_text, to_address), headers=_message_headers(access_token),
    )
    if resp.status_code not in (200, 201):
        raise _message_failure(resp)
    body = _json(resp)
    message_id = str(body.get("id") or "")
    if not message_id:
        raise GraphError(502, "mail_service_unavailable")
    return {
        "id": message_id,
        "internet_message_id": str(body.get("internetMessageId") or ""),
        "conversation_id": str(body.get("conversationId") or ""),
    }


async def send_draft(access_token: str, message_id: str) -> None:
    """Send the draft `message_id` (202 Accepted). A refusal (4xx, 429) or
    failing to connect sent nothing; a timeout or a server error once the
    request was made is uncertain (504 send_timeout, `uncertain`)."""
    _, graph = endpoints()
    resp = await _send(
        "POST", _message_url(graph, message_id, "/send"),
        headers=_message_headers(access_token), uncertain_once_sent=True,
    )
    if resp.status_code == 202:
        return
    if resp.status_code >= 500:
        raise GraphError(504, "send_timeout", uncertain=True)
    raise _message_failure(resp)


async def get_message_state(access_token: str, message_id: str) -> Optional[Dict[str, Any]]:
    """Whether the platform's message `message_id` is still a draft (not sent)
    or went out: {"is_draft", "internet_message_id", "conversation_id"}, or
    None when it no longer exists (deleted). Reads nothing but these fields."""
    _, graph = endpoints()
    resp = await _send(
        "GET", _message_url(graph, message_id),
        params={"$select": "isDraft,internetMessageId,conversationId"}, headers=_message_headers(access_token),
    )
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise _message_failure(resp)
    body = _json(resp)
    if not isinstance(body.get("isDraft"), bool):
        raise GraphError(502, "mail_service_unavailable")
    return {
        "is_draft": body["isDraft"],
        "internet_message_id": str(body.get("internetMessageId") or ""),
        "conversation_id": str(body.get("conversationId") or ""),
    }
