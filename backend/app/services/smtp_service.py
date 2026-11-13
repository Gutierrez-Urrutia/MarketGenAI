"""SMTP account and delivery for prospecting emails (RF-VTA-16).

The account lives in the user's pipeline config (routers/pipeline.py): host,
port, user, sender and the password encrypted with PIPELINE_ENCRYPTION_KEY.
This module:

- tells whether that account is complete (`smtp_config_problems`, the one rule
  shared by the API indicator and the send itself) and whether real sending is
  switched on (`real_send_enabled`: server master switch AND the user's own);
- decrypts the password, only here and only right before connecting;
- refuses an SMTP host that resolves to a loopback / private / link-local
  address (`check_host`), unless SMTP_ALLOW_PRIVATE_HOSTS is on outside
  production;
- builds the message (`build_message`, pure: plain text UTF-8, the opt-out line
  in the email's language appended, CR/LF stripped from every header);
- runs the SMTP conversation step by step (`deliver`), so a failure is known
  to be *before* DATA (nothing was sent: safe to retry) or *during* DATA
  (the server may have accepted it: `uncertain`).

Nothing here logs the password, the recipient or the body: only codes, the
stage and the exception type.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from typing import Any, Dict, List, Mapping, Optional

import aiosmtplib
from cryptography.fernet import InvalidToken

from app.config import settings
from app.core import url_safety
from app.schemas.outreach_email import unsubscribe_line_for
from app.services import encryption_service

logger = logging.getLogger("marketgen.smtp")

# Fields an SMTP account needs, in the order they are reported as missing.
SMTP_REQUIRED_FIELDS = ("smtp_host", "smtp_port", "smtp_user", "smtp_password", "sender_email")
DEFAULT_SMTP_PORT = 587
IMPLICIT_TLS_PORT = 465

_CRLF = re.compile(r"[\r\n]+")


class SmtpError(Exception):
    """A refused or failed SMTP operation, as a code (never the server's text).

    `uncertain` is True only when the message may have been accepted anyway
    (the conversation broke during DATA)."""

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
class SmtpAccount:
    host: str
    port: int
    user: str
    sender_email: str
    sender_name: str = ""


# ── Configuration ────────────────────────────────────────────────────────────
def _valid_port(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65535


def smtp_config_problems(config: Optional[Mapping[str, Any]]) -> List[str]:
    """The SMTP account fields still missing in a pipeline config (a raw
    Firestore document), in SMTP_REQUIRED_FIELDS order. Empty == configured.
    A config without `smtp_port` uses the default (587), like the API. The
    password counts as present when its encrypted value is stored; whether it
    can still be decrypted is checked when it is used. Pure."""
    config = config or {}
    missing: List[str] = []
    if not str(config.get("smtp_host") or "").strip():
        missing.append("smtp_host")
    if not _valid_port(config.get("smtp_port", DEFAULT_SMTP_PORT)):
        missing.append("smtp_port")
    if not str(config.get("smtp_user") or "").strip():
        missing.append("smtp_user")
    if not config.get("smtp_password_encrypted"):
        missing.append("smtp_password")
    if not str(config.get("sender_email") or "").strip():
        missing.append("sender_email")
    return missing


def server_send_enabled() -> bool:
    """The deployment's master switch (OUTREACH_REAL_SEND_ENABLED)."""
    return bool(settings.outreach_real_send_enabled)


def user_send_enabled(config: Optional[Mapping[str, Any]]) -> bool:
    return bool((config or {}).get("outreach_real_send_enabled"))


def real_send_enabled(config: Optional[Mapping[str, Any]]) -> bool:
    """Both switches on: the server's and the user's."""
    return server_send_enabled() and user_send_enabled(config)


def private_hosts_allowed() -> bool:
    """SMTP_ALLOW_PRIVATE_HOSTS, never honoured when APP_ENV=production."""
    return bool(settings.smtp_allow_private_hosts) and settings.app_env.strip().lower() != "production"


def account_from_config(config: Mapping[str, Any]) -> SmtpAccount:
    """The account of a config that passed smtp_config_problems."""
    return SmtpAccount(
        host=str(config.get("smtp_host") or "").strip(),
        port=int(config.get("smtp_port", DEFAULT_SMTP_PORT)),
        user=str(config.get("smtp_user") or "").strip(),
        sender_email=str(config.get("sender_email") or "").strip(),
        sender_name=str(config.get("sender_name") or "").strip(),
    )


def require_account(config: Optional[Mapping[str, Any]]) -> SmtpAccount:
    """The account, or 422 smtp_not_configured with the missing fields."""
    missing = smtp_config_problems(config)
    if missing:
        raise SmtpError(422, "smtp_not_configured", missing=missing)
    return account_from_config(config or {})


def decrypt_password(config: Mapping[str, Any]) -> str:
    """The SMTP password in plain text. 503 encryption_not_configured without
    PIPELINE_ENCRYPTION_KEY; 409 smtp_credentials_unreadable when it was
    encrypted with another key (it must be entered again)."""
    try:
        return encryption_service.decrypt(str(config.get("smtp_password_encrypted") or ""))
    except encryption_service.EncryptionNotConfiguredError as exc:
        raise SmtpError(503, "encryption_not_configured") from exc
    except InvalidToken as exc:
        raise SmtpError(409, "smtp_credentials_unreadable") from exc


async def check_host(host: str) -> None:
    """Refuse an SMTP host that does not resolve (422 smtp_host_unresolvable)
    or resolves to a blocked address (422 smtp_host_blocked; see
    url_safety._is_blocked_ip), unless private hosts are allowed. Called before
    anything is reserved and again right before connecting. Residual risk,
    the same as for the job sources: DNS may change between this check and
    the connection."""
    if private_hosts_allowed():
        return
    try:
        await url_safety.validate_host_target(host, label="SMTP host")
    except url_safety.UnresolvableHostError as exc:
        raise SmtpError(422, "smtp_host_unresolvable") from exc
    except url_safety.UnsafeUrlError as exc:
        raise SmtpError(422, "smtp_host_blocked") from exc


# ── Message ──────────────────────────────────────────────────────────────────
def header_text(value: Any) -> str:
    """A header value with no line breaks (no header injection). Pure."""
    return " ".join(_CRLF.sub(" ", str(value or "")).split())


def body_as_sent(body: Any, language: Optional[str]) -> str:
    """The body exactly as it is sent: the stored body plus the opt-out line
    in the email's language. Pure."""
    return f"{str(body or '').rstrip()}\n\n{unsubscribe_line_for(language)}\n"


def new_message_id(sender_email: str) -> str:
    domain = sender_email.rsplit("@", 1)[-1].strip() or "localhost"
    return make_msgid(domain=header_text(domain))


def build_message(email: Mapping[str, Any], account: SmtpAccount, message_id: str, now: datetime) -> EmailMessage:
    """The message for one prospecting email. Pure: plain text, UTF-8,
    From = sender name <sender email>, Reply-To = sender email."""
    msg = EmailMessage()
    msg["Subject"] = header_text(email.get("subject"))
    msg["From"] = Address(display_name=header_text(account.sender_name), addr_spec=header_text(account.sender_email))
    msg["To"] = Address(addr_spec=header_text(email.get("to_email")))
    msg["Reply-To"] = Address(addr_spec=header_text(account.sender_email))
    msg["Message-ID"] = header_text(message_id)
    msg["Date"] = format_datetime(now)
    msg.set_content(body_as_sent(email.get("body"), email.get("language")), charset="utf-8")
    return msg


# ── SMTP conversation ────────────────────────────────────────────────────────
def _client(account: SmtpAccount, timeout: float) -> aiosmtplib.SMTP:
    """Port 465 → implicit TLS. Any other port → STARTTLS is required, except
    where private hosts are allowed (development/test against a local server
    without TLS), where it is used only if offered."""
    if account.port == IMPLICIT_TLS_PORT:
        tls = {"use_tls": True}
    else:
        tls = {"start_tls": None if private_hosts_allowed() else True}
    return aiosmtplib.SMTP(hostname=account.host, port=account.port, timeout=timeout, **tls)


def _failure(stage: str, exc: BaseException) -> SmtpError:
    """Map an exception raised at `stage` to an SmtpError. Only a break
    during DATA (timeout / disconnection) is uncertain."""
    if isinstance(exc, aiosmtplib.SMTPAuthenticationError):
        return SmtpError(502, "smtp_auth_failed")
    if isinstance(exc, aiosmtplib.SMTPSenderRefused):
        return SmtpError(502, "smtp_sender_refused")
    if isinstance(exc, (aiosmtplib.SMTPRecipientRefused, aiosmtplib.SMTPRecipientsRefused)):
        return SmtpError(502, "smtp_recipient_refused")
    if isinstance(exc, aiosmtplib.SMTPDataError):
        # An explicit refusal of the message: it was not accepted.
        return SmtpError(502, "smtp_message_refused")
    if stage == "data":
        return SmtpError(504, "smtp_timeout", uncertain=True)
    return SmtpError(502, "smtp_unavailable")


async def _quietly_close(client: aiosmtplib.SMTP) -> None:
    try:
        if client.is_connected:
            await asyncio.wait_for(client.quit(), timeout=2)
    except Exception:  # noqa: BLE001 — the outcome is already decided
        client.close()


async def deliver(
    account: SmtpAccount, password: str, message: EmailMessage, timeout: Optional[float] = None,
) -> None:
    """Send `message` to its To address. Raises SmtpError (see _failure).
    The whole conversation is bounded by `timeout` (default
    settings.smtp_timeout_seconds)."""
    timeout = float(timeout or settings.smtp_timeout_seconds)
    await check_host(account.host)
    recipient = str(message["To"].addresses[0].addr_spec)
    client = _client(account, timeout)
    stage = "connect"
    try:
        async with asyncio.timeout(timeout):
            await client.connect()
            stage = "login"
            await client.login(account.user, password)
            stage = "mail"
            await client.mail(account.sender_email)
            stage = "rcpt"
            await client.rcpt(recipient)
            stage = "data"
            await client.data(message.as_bytes())
            stage = "done"
    except (aiosmtplib.SMTPException, OSError, asyncio.TimeoutError) as exc:
        failure = _failure(stage, exc)
        logger.warning("smtp: delivery failed at %s (%s → %s)", stage, type(exc).__name__, failure.code)
        raise failure from None
    finally:
        await _quietly_close(client)


async def check_connection(account: SmtpAccount, password: str, timeout: Optional[float] = None) -> None:
    """Connect, log in and NOOP; nothing is sent. Raises SmtpError."""
    timeout = float(timeout or settings.smtp_timeout_seconds)
    await check_host(account.host)
    client = _client(account, timeout)
    stage = "connect"
    try:
        async with asyncio.timeout(timeout):
            await client.connect()
            stage = "login"
            await client.login(account.user, password)
            stage = "noop"
            await client.noop()
    except (aiosmtplib.SMTPException, OSError, asyncio.TimeoutError) as exc:
        failure = _failure(stage, exc)
        logger.warning("smtp: connection test failed at %s (%s → %s)", stage, type(exc).__name__, failure.code)
        raise failure from None
    finally:
        await _quietly_close(client)
