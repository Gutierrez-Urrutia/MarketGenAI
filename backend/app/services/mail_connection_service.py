"""Mailbox connection (RF-VTA-16): each user connects their own Microsoft 365
/ Outlook mailbox, or their Gmail, so that prospecting emails go out from it.
The provider is chosen on `start` and kept on the connection; everything
below works the same for both (mail_providers gives the right client).

Flow (authorization code + PKCE, delegated):
  1. start(user) — authenticated. Draws an OAuth `state` and a PKCE verifier,
     stores {user, verifier (encrypted), expires_at} under sha256(state) and
     returns Microsoft's authorization URL. The frontend navigates there.
  2. complete(state, code) — the browser POSTs Microsoft's answer
     (form_post) to the callback, without our JWT: the stored `state` is what
     says whose mailbox it is. It is single use and expires
     (MAIL_OAUTH_STATE_TTL_SECONDS); the code is exchanged with its verifier,
     the mailbox is read (GET /me), and the tokens are stored encrypted in
     mail_connections/{user}. It always ends in a redirect to the frontend
     with `mail_connection=connected` or `mail_connection_error=<code>`.
  3. access_token(user) — for sending (phase 2) and the test. Renews the
     access token when less than MAIL_TOKEN_REFRESH_MARGIN_SECONDS is left,
     storing the rotated refresh token only if nobody refreshed meanwhile.
     When only a new consent helps (revoked or expired refresh token,
     unreadable tokens) the connection is flagged `needs_reconnect` and 409
     mailbox_reconnect_required is raised: sending stays blocked, nothing else
     changes.

Never logged nor returned: tokens, the code, the state, the PKCE verifier,
Microsoft's error descriptions, the mailbox address.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlencode

from cryptography.fernet import InvalidToken

from app.config import settings
from app.core.pipeline_constants import (
    MAIL_OAUTH_STATE_TTL_SECONDS,
    MAIL_TOKEN_REFRESH_MARGIN_SECONDS,
)
from app.services import encryption_service, mail_providers
from app.services.encryption_service import EncryptionNotConfiguredError
from app.services.graph_client import GraphError

logger = logging.getLogger("marketgen.mail_connection")

# Microsoft's AADSTS codes meaning "an administrator must approve this app".
_ADMIN_CONSENT_CODES = ("AADSTS90094", "AADSTS90095")


class MailConnectionError(Exception):
    """A refusal with an HTTP status and a code (never free text)."""

    def __init__(self, status_code: int, code: str, **extra: Any):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.extra = extra

    @property
    def detail(self) -> Dict[str, Any]:
        return {"code": self.code, **self.extra}


class _CallbackRefused(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def frontend_redirect(**params: str) -> str:
    """The frontend page the callback sends the browser back to."""
    return f"{settings.effective_frontend_url.rstrip('/')}/?{urlencode(params)}"


def consent_error_code(error: str, description: Optional[str]) -> str:
    """Our code for Microsoft's `error` on the callback (its description is
    only searched for an AADSTS code, never stored or logged)."""
    text = str(description or "")
    if any(code in text for code in _ADMIN_CONSENT_CODES):
        return "admin_consent_required"
    if error == "access_denied":
        return "consent_denied"
    return "authorization_failed"


def _utc(value: Any) -> Optional[datetime]:
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


class MailConnectionService:
    def __init__(self, states, connections, clock: Optional[Callable[[], datetime]] = None):
        self.states = states
        self.connections = connections
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    # ── 1. start ─────────────────────────────────────────────────────────────
    async def start(
        self, user_id: str, provider: Optional[str] = None, login_hint: Optional[str] = None,
    ) -> Dict[str, str]:
        """422 unknown_provider, 503 mail_oauth_not_configured (no app
        registration for that provider), mail_endpoints_not_allowed,
        encryption_not_configured. `login_hint` (Gmail only) pre-selects the
        Google account the user signed in with."""
        try:
            name = mail_providers.normalize(provider)
        except ValueError:
            raise MailConnectionError(422, "unknown_provider") from None
        mail = mail_providers.client(name)
        if not mail.oauth_configured():
            raise MailConnectionError(503, "mail_oauth_not_configured")
        try:
            mail.check_endpoints()
        except GraphError as exc:
            raise MailConnectionError(exc.status_code, exc.code) from None
        state = secrets.token_urlsafe(32)
        verifier = mail.new_code_verifier()
        try:
            verifier_encrypted = encryption_service.encrypt(verifier)
        except EncryptionNotConfiguredError:
            raise MailConnectionError(503, "encryption_not_configured") from None
        now = self.clock()
        await self.states.create({
            "user_id": user_id,
            "provider": name,
            "code_verifier_encrypted": verifier_encrypted,
            "expires_at": now + timedelta(seconds=MAIL_OAUTH_STATE_TTL_SECONDS),
            "used": False,
        }, doc_id=self.states.doc_id_for(state))
        challenge = mail.code_challenge(verifier)
        if name == mail_providers.GOOGLE:
            return {"authorize_url": mail.authorize_url(state, challenge, login_hint=login_hint)}
        return {"authorize_url": mail.authorize_url(state, challenge)}

    # ── 2. callback ──────────────────────────────────────────────────────────
    async def complete(
        self, state: Optional[str], code: Optional[str],
        error: Optional[str] = None, error_description: Optional[str] = None,
    ) -> str:
        """Finish a connection. Returns the frontend URL to redirect to; never
        raises."""
        try:
            await self._complete(state, code, error, error_description)
        except _CallbackRefused as refused:
            logger.info("mail_connection: callback refused (%s)", refused.code)
            return frontend_redirect(mail_connection_error=refused.code)
        except Exception as exc:  # noqa: BLE001 — the browser must always land somewhere
            logger.error("mail_connection: unexpected failure in the callback (%s)", type(exc).__name__)
            return frontend_redirect(mail_connection_error="server_error")
        logger.info("mail_connection: mailbox connected")
        return frontend_redirect(mail_connection="connected")

    async def _complete(self, state, code, error, error_description) -> None:
        if not state:
            raise _CallbackRefused("invalid_state")
        # Consumed first: whatever happens next, this state never works again.
        pending = await self.states.consume(state, self.clock())
        if not pending or not pending.get("user_id"):
            raise _CallbackRefused("invalid_state")
        user_id = pending["user_id"]
        name = mail_providers.normalize(pending.get("provider"))
        mail = mail_providers.client(name)
        if error:
            raise _CallbackRefused(consent_error_code(error, error_description))
        if not code:
            raise _CallbackRefused("authorization_failed")
        try:
            verifier = encryption_service.decrypt(pending.get("code_verifier_encrypted") or "")
        except EncryptionNotConfiguredError:
            raise _CallbackRefused("encryption_not_configured") from None
        except InvalidToken:
            raise _CallbackRefused("invalid_state") from None

        try:
            tokens = await mail.exchange_code(code, verifier)
        except GraphError as exc:
            # A refused code (expired, reused, wrong verifier) is just a failed authorization.
            raise _CallbackRefused(
                "authorization_failed" if exc.code in ("mailbox_reconnect_required", "mailbox_auth_failed") else exc.code,
            ) from None
        granted = {scope.lower() for scope in tokens.scopes}
        if not tokens.refresh_token or any(scope.lower() not in granted for scope in mail.REQUIRED_SCOPES):
            raise _CallbackRefused("missing_permissions")
        try:
            me = await mail.get_me(tokens.access_token)
        except GraphError as exc:
            raise _CallbackRefused("authorization_failed" if exc.code == "mailbox_reconnect_required" else exc.code) from None

        now = self.clock()
        try:
            secrets_encrypted = {
                "access_token_encrypted": encryption_service.encrypt(tokens.access_token),
                "refresh_token_encrypted": encryption_service.encrypt(tokens.refresh_token),
            }
        except EncryptionNotConfiguredError:
            raise _CallbackRefused("encryption_not_configured") from None
        await self.connections.save(user_id, {
            "provider": name,
            "address": me["address"],
            "display_name": me["display_name"],
            "account_id": me["id"],
            "scopes": list(tokens.scopes),
            **secrets_encrypted,
            "access_expires_at": now + timedelta(seconds=tokens.expires_in),
            "connected_at": now,
        })

    # ── status / test / disconnect ───────────────────────────────────────────
    async def status(self, user_id: str) -> Dict[str, Any]:
        conn = await self.connections.for_user(user_id)
        providers = mail_providers.configured()
        return {
            "oauth_configured": any(providers.values()),
            "providers": providers,
            "provider": mail_providers.normalize(conn.get("provider")) if conn else None,
            "connected": bool(conn),
            "needs_reconnect": bool(conn and conn.get("needs_reconnect")),
            "address": (conn or {}).get("address"),
            "display_name": (conn or {}).get("display_name"),
            "connected_at": (conn or {}).get("connected_at"),
        }

    async def test(self, user_id: str) -> Dict[str, Any]:
        """Renew the token if needed and read the mailbox (GET /me). Nothing
        is sent."""
        token = await self.access_token(user_id)
        conn = await self.connections.for_user(user_id)
        try:
            me = await mail_providers.client((conn or {}).get("provider")).get_me(token)
        except GraphError as exc:
            if exc.code == "mailbox_reconnect_required":
                await self.connections.mark_needs_reconnect(user_id, exc.code)
            raise MailConnectionError(exc.status_code, exc.code, **exc.extra) from None
        return {"ok": True, "address": me["address"], "display_name": me["display_name"]}

    async def disconnect(self, user_id: str) -> None:
        """Forget the mailbox: its tokens are deleted here. (A delegated
        consent can only be withdrawn by the user, from their Microsoft
        account; the frontend says so.)"""
        if await self.connections.for_user(user_id):
            await self.connections.delete(user_id)

    # ── 3. access token ──────────────────────────────────────────────────────
    async def for_send(self, user_id: str) -> Dict[str, str]:
        """What a send needs: {"access_token", "address", "display_name",
        "provider"} of the connected mailbox. Same refusals as access_token."""
        token = await self.access_token(user_id)
        conn = await self.connections.for_user(user_id)
        if not conn:
            raise MailConnectionError(409, "mailbox_not_connected")
        return {
            "access_token": token,
            "address": str(conn.get("address") or ""),
            "display_name": str(conn.get("display_name") or ""),
            "provider": mail_providers.normalize(conn.get("provider")),
        }

    async def flag_reconnect(self, user_id: str, reason: str) -> None:
        """The mail service refused the token (401) during a send."""
        await self.connections.mark_needs_reconnect(user_id, reason)

    async def access_token(self, user_id: str) -> str:
        """A usable access token for the user's mailbox. 409
        mailbox_not_connected / mailbox_reconnect_required, 503
        encryption_not_configured, or the GraphError of the refresh
        (unavailable, timeout, throttled)."""
        conn = await self.connections.for_user(user_id)
        if not conn:
            raise MailConnectionError(409, "mailbox_not_connected")
        if conn.get("needs_reconnect"):
            raise MailConnectionError(409, "mailbox_reconnect_required")
        expires_at = _utc(conn.get("access_expires_at"))
        if expires_at and expires_at - self.clock() > timedelta(seconds=MAIL_TOKEN_REFRESH_MARGIN_SECONDS):
            try:
                return encryption_service.decrypt(conn.get("access_token_encrypted") or "")
            except EncryptionNotConfiguredError:
                raise MailConnectionError(503, "encryption_not_configured") from None
            except InvalidToken:
                await self._reconnect_required(user_id, "tokens_unreadable")
        return await self._refresh(user_id, conn)

    async def _reconnect_required(self, user_id: str, reason: str) -> None:
        await self.connections.mark_needs_reconnect(user_id, reason)
        raise MailConnectionError(409, "mailbox_reconnect_required")

    async def _refresh(self, user_id: str, conn: Dict[str, Any]) -> str:
        try:
            refresh_token = encryption_service.decrypt(conn.get("refresh_token_encrypted") or "")
        except EncryptionNotConfiguredError:
            raise MailConnectionError(503, "encryption_not_configured") from None
        except InvalidToken:
            await self._reconnect_required(user_id, "tokens_unreadable")
        try:
            tokens = await mail_providers.client(conn.get("provider")).refresh(refresh_token)
        except GraphError as exc:
            if exc.code == "mailbox_reconnect_required":
                await self._reconnect_required(user_id, "refresh_refused")
            raise MailConnectionError(exc.status_code, exc.code, **exc.extra) from None
        fields = {
            "access_token_encrypted": encryption_service.encrypt(tokens.access_token),
            "refresh_token_encrypted": encryption_service.encrypt(tokens.refresh_token),
            "access_expires_at": self.clock() + timedelta(seconds=tokens.expires_in),
        }
        result = await self.connections.replace_tokens(user_id, int(conn.get("token_version") or 0), fields)
        if not result["ok"] and result["doc"] is None:
            # Disconnected while we were refreshing: the new tokens are dropped.
            raise MailConnectionError(409, "mailbox_not_connected")
        # When another request refreshed first, its tokens are the stored
        # ones; ours is still a valid access token for this call.
        return tokens.access_token


_service: Optional[MailConnectionService] = None


def get_service() -> MailConnectionService:
    """The service wired to Firestore (tests build their own)."""
    global _service
    if _service is None:
        from app.services.firestore_service import mail_connections_repo, mail_oauth_states_repo

        _service = MailConnectionService(mail_oauth_states_repo, mail_connections_repo)
    return _service
