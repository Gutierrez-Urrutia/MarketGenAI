"""Google identity platform + Gmail API client for the mailbox connection (RF-VTA-16): users who sign in with
Google connect their own Gmail mailbox with delegated OAuth (authorization code + PKCE), as the Microsoft users
do with Outlook (graph_client.py). It has the same functions, so MailConnectionService and OutreachEmailService
use either one through mail_providers.

Differences with Microsoft that matter here:
- Google answers the authorization with a GET (`?code=...&state=...`), not a form POST. The code is single use,
  short lived and useless without the PKCE verifier, which only this server holds.
- Scope: gmail.compose (create a draft and send it). It cannot read the mailbox, so no message is ever read.
- The access token lasts one hour and the refresh token is not rotated: `refresh` keeps the current one.
- A sent draft disappears from the drafts: `get_message_state` can tell "still a draft" from "no longer a
  draft" (sent or deleted by the user), never "sent" for sure. OutreachEmailService is conservative about that:
  an uncertain send stays uncertain until the user resolves it.
- While the Google app is in "Testing" status, refresh tokens expire after 7 days: the connection then turns
  into `mailbox_reconnect_required` and the user connects again.

Errors reuse GraphError (a code, never the server's text). Never logs a token, a code or a response body.
"""
from __future__ import annotations

import base64
from email.message import EmailMessage
from email.utils import make_msgid
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote, urlencode

import httpx

from app.config import settings
from app.core.pipeline_constants import MAIL_GOOGLE_REQUIRED_SCOPES, MAIL_GOOGLE_SCOPES
from app.services.graph_client import (  # same wire helpers and error type as the Microsoft client
    GraphError,
    TokenSet,
    _json,
    _scope_names,
    _single_line,
    _transport_failure,
    code_challenge,
    new_code_verifier,
)

__all__ = ["GraphError", "TokenSet", "code_challenge", "new_code_verifier"]

PROVIDER = "google"
REQUIRED_SCOPES = MAIL_GOOGLE_REQUIRED_SCOPES

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

# Token errors after which only a new consent helps.
_RECONNECT_ERRORS = {"invalid_grant", "interaction_required", "consent_required", "login_required"}
# 403 reasons that mean "slow down", not "no permission".
_RATE_REASONS = {"rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"}


# -- Configuration ---------------------------------------------------------------------------------------------
def oauth_configured() -> bool:
    """Whether the Google OAuth client (the login one) is set."""
    return bool(settings.google_oauth_client_id.strip() and settings.google_oauth_client_secret.strip())


def check_endpoints() -> None:
    """Google's endpoints are fixed: nothing to guard."""


def authorize_url(state: str, challenge: str, login_hint: Optional[str] = None) -> str:
    """Where the browser goes to consent. Google answers with a GET to MAIL_GOOGLE_REDIRECT_URL carrying `code`
    and `state`. `login_hint` pre-selects the account the user signed in with."""
    params = {
        "client_id": settings.google_oauth_client_id.strip(),
        "response_type": "code",
        "redirect_uri": settings.mail_google_redirect_url.strip(),
        "scope": " ".join(MAIL_GOOGLE_SCOPES),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        # offline + consent: Google only returns a refresh token when asked for it on a consent screen.
        "access_type": "offline",
        "prompt": "consent select_account",
    }
    if login_hint and "@" in login_hint:
        params["login_hint"] = login_hint.strip()
    return f"{AUTH_URL}?{urlencode(params)}"


# -- HTTP ------------------------------------------------------------------------------------------------------
def _new_client() -> httpx.AsyncClient:
    """One client per call. Redirects are never followed. Tests replace this."""
    return httpx.AsyncClient(timeout=settings.mail_http_timeout_seconds, follow_redirects=False)


async def _send(method: str, url: str, *, uncertain_once_sent: bool = False, **kwargs: Any) -> httpx.Response:
    """One HTTP call. With `uncertain_once_sent` (sending the draft), a failure after the connection was made --
    the request may have reached Google -- is 504 send_timeout, uncertain; failing to connect is always safe."""
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


async def _token_request(form: Dict[str, str], previous_refresh_token: str = "") -> TokenSet:
    data = {
        "client_id": settings.google_oauth_client_id.strip(),
        "client_secret": settings.google_oauth_client_secret.strip(),
        **form,
    }
    resp = await _send("POST", TOKEN_URL, data=data, headers={"Accept": "application/json"})
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
    """Exchange an authorization code (with its PKCE verifier) for tokens. The set may lack a refresh token: the
    caller decides."""
    return await _token_request({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.mail_google_redirect_url.strip(),
        "code_verifier": code_verifier,
    })


async def refresh(refresh_token: str) -> TokenSet:
    """A new access token (Google does not rotate the refresh token: the current one is kept). 409
    mailbox_reconnect_required when only a new consent helps."""
    return await _token_request(
        {"grant_type": "refresh_token", "refresh_token": refresh_token}, previous_refresh_token=refresh_token,
    )


async def get_me(access_token: str) -> Dict[str, str]:
    """The signed-in account: {"id", "address", "display_name"} (OpenID userinfo)."""
    resp = await _send(
        "GET", USERINFO_URL, headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
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
    address = str(body.get("email") or "").strip()
    if "@" not in address:
        raise GraphError(422, "mailbox_without_address")
    return {
        "id": str(body.get("sub") or ""),
        "address": address,
        "display_name": str(body.get("name") or "").strip(),
    }


# -- Drafts (only the platform's own) --------------------------------------------------------------------------
def _headers(access_token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}


def _draft_url(draft_id: str) -> str:
    return f"{GMAIL_BASE}/drafts/{quote(draft_id, safe='')}"


def _reason(resp: httpx.Response) -> str:
    """Google's machine reason of an error (e.g. rateLimitExceeded), never its text."""
    try:
        errors = _json(resp).get("error", {}).get("errors") or []
        return str(errors[0].get("reason") or "") if errors else ""
    except (AttributeError, IndexError, TypeError):
        return ""


def _message_failure(resp: httpx.Response) -> GraphError:
    """A refusal of a Gmail call that sent nothing."""
    failure = _transport_failure(resp)
    if failure:
        return failure
    if resp.status_code == 401:
        return GraphError(409, "mailbox_reconnect_required")
    if resp.status_code == 403:
        reason = _reason(resp)
        if reason in _RATE_REASONS:
            return GraphError(503, "mail_throttled")
        if reason in ("accessNotConfigured", "SERVICE_DISABLED"):
            # The Gmail API is not enabled in the Google Cloud project: nothing the user can fix.
            return GraphError(502, "mail_service_unavailable")
        return GraphError(409, "missing_permissions")
    # 400 / 404 / 413...: Gmail refused this message (bad recipient, too large...).
    return GraphError(502, "mail_rejected")


def build_raw_message(subject: Any, body_text: str, to_address: str) -> Tuple[str, str]:
    """The RFC 5322 message of one prospecting email (plain text, UTF-8, one recipient), base64url-encoded as
    Gmail wants it, and its Message-ID. The sender is the signed-in mailbox itself. Pure."""
    message = EmailMessage()
    message["To"] = to_address
    message["Subject"] = _single_line(subject)
    message_id = make_msgid(domain="marketgen.mail")
    message["Message-ID"] = message_id
    message.set_content(body_text, charset="utf-8")
    return base64.urlsafe_b64encode(message.as_bytes()).decode("ascii"), message_id


async def create_draft(access_token: str, subject: Any, body_text: str, to_address: str) -> Dict[str, str]:
    """Create the email as a draft in the user's Gmail. Nothing is sent. Returns {"id" (the draft's),
    "internet_message_id", "conversation_id" (the thread)}. Any failure here is safe: at most an unsent draft."""
    raw, message_id = build_raw_message(subject, body_text, to_address)
    resp = await _send(
        "POST", f"{GMAIL_BASE}/drafts", json={"message": {"raw": raw}}, headers=_headers(access_token),
    )
    if resp.status_code not in (200, 201):
        raise _message_failure(resp)
    body = _json(resp)
    draft_id = str(body.get("id") or "")
    if not draft_id:
        raise GraphError(502, "mail_service_unavailable")
    thread = body.get("message") if isinstance(body.get("message"), dict) else {}
    return {"id": draft_id, "internet_message_id": message_id, "conversation_id": str(thread.get("threadId") or "")}


async def send_draft(access_token: str, message_id: str) -> None:
    """Send the draft `message_id` (here, the draft's id). A refusal (4xx, 429) or failing to connect sent
    nothing; a timeout or a server error once the request was made is uncertain (504 send_timeout)."""
    resp = await _send(
        "POST", f"{GMAIL_BASE}/drafts/send", json={"id": message_id}, headers=_headers(access_token),
        uncertain_once_sent=True,
    )
    if resp.status_code == 200:
        return
    if resp.status_code >= 500:
        raise GraphError(504, "send_timeout", uncertain=True)
    raise _message_failure(resp)


async def get_message_state(access_token: str, message_id: str) -> Optional[Dict[str, Any]]:
    """Whether the draft `message_id` still exists: {"is_draft": True, ...} when it does (so it was not sent),
    None when it does not (it was sent or the user deleted it: Gmail cannot say which without reading the
    mailbox, which this app never does)."""
    resp = await _send("GET", _draft_url(message_id), params={"format": "minimal"}, headers=_headers(access_token))
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise _message_failure(resp)
    body = _json(resp)
    if not body.get("id"):
        raise GraphError(502, "mail_service_unavailable")
    thread = body.get("message") if isinstance(body.get("message"), dict) else {}
    return {"is_draft": True, "internet_message_id": "", "conversation_id": str(thread.get("threadId") or "")}
