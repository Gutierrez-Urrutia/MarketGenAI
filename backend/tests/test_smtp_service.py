"""smtp_service (RF-VTA-16, envío real): account rule, switches, SMTP host
check, message building and the SMTP conversation against a local fake
server (aiosmtpd on 127.0.0.1, in-process, no Docker). Synthetic data only;
no real email is sent and nothing leaves the machine."""
from __future__ import annotations

import asyncio
import socket
import warnings
from datetime import datetime, timezone
from email import message_from_bytes, policy
from unittest.mock import patch

import aiosmtplib
import pytest
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult, LoginPassword
from cryptography.fernet import Fernet

from app.core import url_safety
from app.core.pipeline_constants import OUTREACH_UNSUBSCRIBE_LINE
from app.services import encryption_service, smtp_service
from app.services.smtp_service import SmtpAccount, SmtpError

T0 = datetime(2026, 11, 12, 15, 0, tzinfo=timezone.utc)
SMTP_USER = "smtp-user"
SMTP_PASSWORD = "fake-password-123"
SENDER = "ventas@example.test"
RECIPIENT = "destino@example.test"

COMPLETE = {
    "smtp_host": "smtp.example.test", "smtp_port": 587, "smtp_user": SMTP_USER,
    "smtp_password_encrypted": "token", "sender_email": SENDER, "sender_name": "Equipo Ventas",
}


def email_doc(**overrides):
    return {"subject": "Asunto", "body": "Hola,\n\nCuerpo.\n\nEquipo NoonDalton", "to_email": RECIPIENT,
            "language": "es", **overrides}


def resolves_to(ip):
    def fake_getaddrinfo(host, port, *args, **kwargs):
        family = socket.AF_INET6 if ":" in ip else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, "", (ip, 0))]
    return patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo)


@pytest.fixture
def private_hosts(monkeypatch):
    """SMTP_ALLOW_PRIVATE_HOSTS on, outside production: the fake server is on 127.0.0.1."""
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", True)
    monkeypatch.setattr(smtp_service.settings, "app_env", "test")


# ── Account rule ─────────────────────────────────────────────────────────────
def test_a_complete_account_has_no_problems():
    assert smtp_service.smtp_config_problems(COMPLETE) == []


@pytest.mark.parametrize("field, change", [
    ("smtp_host", {"smtp_host": "  "}),
    ("smtp_port", {"smtp_port": 0}),
    ("smtp_port", {"smtp_port": 70000}),
    ("smtp_port", {"smtp_port": "587"}),
    ("smtp_port", {"smtp_port": True}),
    ("smtp_user", {"smtp_user": ""}),
    ("smtp_password", {"smtp_password_encrypted": ""}),
    ("sender_email", {"sender_email": None}),
])
def test_each_missing_field_is_reported(field, change):
    assert smtp_service.smtp_config_problems({**COMPLETE, **change}) == [field]


def test_an_empty_config_reports_everything_but_the_default_port():
    assert smtp_service.smtp_config_problems(None) == ["smtp_host", "smtp_user", "smtp_password", "sender_email"]


def test_require_account_refuses_with_the_missing_fields():
    with pytest.raises(SmtpError) as err:
        smtp_service.require_account({**COMPLETE, "smtp_host": "", "sender_email": ""})
    assert err.value.status_code == 422
    assert err.value.detail == {"code": "smtp_not_configured", "missing": ["smtp_host", "sender_email"]}


# ── Switches ─────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("server, user, expected", [
    (False, False, False), (True, False, False), (False, True, False), (True, True, True),
])
def test_real_send_needs_both_switches(monkeypatch, server, user, expected):
    monkeypatch.setattr(smtp_service.settings, "outreach_real_send_enabled", server)
    assert smtp_service.real_send_enabled({"outreach_real_send_enabled": user}) is expected


@pytest.mark.parametrize("allow, env, expected", [
    (False, "test", False), (True, "test", True), (True, "development", True),
    (True, "production", False), (True, " Production ", False),
])
def test_private_hosts_are_never_allowed_in_production(monkeypatch, allow, env, expected):
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", allow)
    monkeypatch.setattr(smtp_service.settings, "app_env", env)
    assert smtp_service.private_hosts_allowed() is expected


# ── Password ─────────────────────────────────────────────────────────────────
@pytest.fixture
def encryption_key(monkeypatch):
    monkeypatch.setattr(encryption_service.settings, "pipeline_encryption_key", Fernet.generate_key().decode())
    encryption_service._fernet.cache_clear()
    yield
    encryption_service._fernet.cache_clear()


def test_decrypt_password(encryption_key):
    token = encryption_service.encrypt(SMTP_PASSWORD)
    assert smtp_service.decrypt_password({"smtp_password_encrypted": token}) == SMTP_PASSWORD


def test_a_password_from_another_key_is_unreadable(encryption_key):
    foreign = Fernet(Fernet.generate_key()).encrypt(b"x").decode()
    with pytest.raises(SmtpError) as err:
        smtp_service.decrypt_password({"smtp_password_encrypted": foreign})
    assert (err.value.status_code, err.value.code) == (409, "smtp_credentials_unreadable")


def test_without_the_encryption_key(monkeypatch):
    monkeypatch.setattr(encryption_service.settings, "pipeline_encryption_key", "")
    encryption_service._fernet.cache_clear()
    try:
        with pytest.raises(SmtpError) as err:
            smtp_service.decrypt_password({"smtp_password_encrypted": "token"})
        assert (err.value.status_code, err.value.code) == (503, "encryption_not_configured")
    finally:
        encryption_service._fernet.cache_clear()


# ── SMTP host check ──────────────────────────────────────────────────────────
@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.5", "192.168.1.20", "172.16.0.1", "169.254.169.254", "::1"])
async def test_internal_hosts_are_blocked(ip):
    with resolves_to(ip):
        with pytest.raises(SmtpError) as err:
            await smtp_service.check_host("smtp.example.test")
    assert (err.value.status_code, err.value.code) == (422, "smtp_host_blocked")


async def test_a_public_host_is_allowed():
    with resolves_to("93.184.216.34"):
        await smtp_service.check_host("smtp.example.test")


async def test_an_unresolvable_host():
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=socket.gaierror("no such host")):
        with pytest.raises(SmtpError) as err:
            await smtp_service.check_host("nowhere.example.test")
    assert (err.value.status_code, err.value.code) == (422, "smtp_host_unresolvable")


async def test_internal_hosts_are_allowed_with_the_switch_outside_production(private_hosts):
    with resolves_to("127.0.0.1"):
        await smtp_service.check_host("localhost")


async def test_the_switch_is_ignored_in_production(monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", True)
    monkeypatch.setattr(smtp_service.settings, "app_env", "production")
    with resolves_to("127.0.0.1"):
        with pytest.raises(SmtpError) as err:
            await smtp_service.check_host("localhost")
    assert err.value.code == "smtp_host_blocked"


async def test_url_safety_messages_are_unchanged():
    with resolves_to("10.0.0.1"):
        with pytest.raises(url_safety.UnsafeUrlError, match="URL host 'feed.example.test' resolves to a blocked"):
            await url_safety.validate_url_target("https://feed.example.test/rss")


# ── Message ──────────────────────────────────────────────────────────────────
ACCOUNT = SmtpAccount("smtp.example.test", 587, SMTP_USER, SENDER, "Equipo Ñandú")


@pytest.mark.parametrize("language, expected", [
    ("en", OUTREACH_UNSUBSCRIBE_LINE["en"]), ("es", OUTREACH_UNSUBSCRIBE_LINE["es"]),
    ("pt", OUTREACH_UNSUBSCRIBE_LINE["pt"]), (None, OUTREACH_UNSUBSCRIBE_LINE["en"]),
])
def test_the_unsubscribe_line_goes_in_the_email_language(language, expected):
    msg = smtp_service.build_message(email_doc(language=language), ACCOUNT, "<id@example.test>", T0)
    assert msg.get_content().rstrip().endswith(expected)
    assert smtp_service.body_as_sent("Cuerpo", language) == f"Cuerpo\n\n{expected}\n"


def test_the_message_headers():
    msg = smtp_service.build_message(email_doc(), ACCOUNT, "<abc@example.test>", T0)
    parsed = message_from_bytes(msg.as_bytes(), policy=policy.default)
    assert parsed["To"] == RECIPIENT
    assert parsed["From"].addresses[0].addr_spec == SENDER
    assert parsed["From"].addresses[0].display_name == "Equipo Ñandú"
    assert parsed["Reply-To"] == SENDER
    assert parsed["Message-ID"] == "<abc@example.test>"
    assert parsed.get_content_type() == "text/plain" and parsed.get_content_charset() == "utf-8"
    assert parsed.get_content().startswith("Hola,\n\nCuerpo.")


def test_line_breaks_never_reach_a_header():
    msg = smtp_service.build_message(
        email_doc(subject="Hola\r\nBcc: oculto@example.test", body="b"),
        SmtpAccount("h", 587, "u", SENDER, "Ventas\nBcc: otro@example.test"), "<id@example.test>", T0,
    )
    raw = msg.as_bytes().decode("utf-8")
    header_block = raw.split("\n\n", 1)[0]
    assert "\nBcc:" not in header_block and "\r\nBcc:" not in header_block
    assert msg["Subject"] == "Hola Bcc: oculto@example.test"


def test_the_message_id_uses_the_sender_domain():
    assert smtp_service.new_message_id(SENDER).endswith("@example.test>")


# ── Failure mapping ──────────────────────────────────────────────────────────
@pytest.mark.parametrize("stage, exc, code, uncertain", [
    ("login", aiosmtplib.SMTPAuthenticationError(535, "no"), "smtp_auth_failed", False),
    ("mail", aiosmtplib.SMTPSenderRefused(550, "no", SENDER), "smtp_sender_refused", False),
    ("rcpt", aiosmtplib.SMTPRecipientRefused(550, "no", RECIPIENT), "smtp_recipient_refused", False),
    ("data", aiosmtplib.SMTPDataError(554, "no"), "smtp_message_refused", False),
    ("connect", aiosmtplib.SMTPConnectError("down"), "smtp_unavailable", False),
    ("connect", TimeoutError(), "smtp_unavailable", False),
    ("rcpt", aiosmtplib.SMTPServerDisconnected("bye"), "smtp_unavailable", False),
    ("data", TimeoutError(), "smtp_timeout", True),
    ("data", aiosmtplib.SMTPServerDisconnected("bye"), "smtp_timeout", True),
])
def test_failures_before_data_are_safe_and_during_data_uncertain(stage, exc, code, uncertain):
    failure = smtp_service._failure(stage, exc)
    assert failure.code == code and failure.uncertain is uncertain


# ── Against a local fake SMTP server (aiosmtpd) ──────────────────────────────
class Recorder:
    def __init__(self, data_delay: float = 0):
        self.envelopes = []
        self.data_delay = data_delay

    async def handle_DATA(self, server, session, envelope):
        if self.data_delay:
            await asyncio.sleep(self.data_delay)
        self.envelopes.append(envelope)
        return "250 OK"


def _authenticator(server, session, envelope, mechanism, auth_data):
    ok = isinstance(auth_data, LoginPassword) and auth_data.login == SMTP_USER.encode() \
        and auth_data.password == SMTP_PASSWORD.encode()
    # handled=False: aiosmtpd answers 535 itself (with handled=True it stays silent).
    return AuthResult(success=ok, handled=False)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def fake_smtp(private_hosts):
    """A local SMTP server requiring AUTH PLAIN (no TLS: test only)."""
    servers = []

    def start(data_delay: float = 0):
        handler = Recorder(data_delay)
        port = _free_port()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            controller = Controller(
                handler, hostname="127.0.0.1", port=port, authenticator=_authenticator,
                auth_require_tls=False, auth_required=True, auth_exclude_mechanism=["LOGIN"],
            )
            controller.start()
        servers.append(controller)
        return handler, SmtpAccount("127.0.0.1", port, SMTP_USER, SENDER, "Equipo Ventas")

    yield start
    for controller in servers:
        controller.stop()


async def test_deliver_reaches_the_fake_server(fake_smtp):
    handler, account = fake_smtp()
    msg = smtp_service.build_message(email_doc(), account, smtp_service.new_message_id(SENDER), T0)
    await smtp_service.deliver(account, SMTP_PASSWORD, msg, timeout=5)
    assert len(handler.envelopes) == 1
    envelope = handler.envelopes[0]
    assert envelope.mail_from == SENDER and envelope.rcpt_tos == [RECIPIENT]
    received = message_from_bytes(envelope.original_content, policy=policy.default)
    assert received["Subject"] == "Asunto" and received["Message-ID"] == msg["Message-ID"]
    assert received.get_content().rstrip().endswith(OUTREACH_UNSUBSCRIBE_LINE["es"])


async def test_a_wrong_password_is_auth_failed_and_sends_nothing(fake_smtp):
    handler, account = fake_smtp()
    msg = smtp_service.build_message(email_doc(), account, "<x@example.test>", T0)
    with pytest.raises(SmtpError) as err:
        await smtp_service.deliver(account, "wrong", msg, timeout=5)
    assert (err.value.code, err.value.uncertain) == ("smtp_auth_failed", False)
    assert handler.envelopes == []


async def test_a_server_that_stalls_during_data_is_uncertain(fake_smtp):
    handler, account = fake_smtp(data_delay=3)
    msg = smtp_service.build_message(email_doc(), account, "<x@example.test>", T0)
    with pytest.raises(SmtpError) as err:
        await smtp_service.deliver(account, SMTP_PASSWORD, msg, timeout=1)
    assert (err.value.status_code, err.value.code, err.value.uncertain) == (504, "smtp_timeout", True)


async def test_nobody_listening_is_unavailable(private_hosts):
    account = SmtpAccount("127.0.0.1", _free_port(), SMTP_USER, SENDER)
    msg = smtp_service.build_message(email_doc(), account, "<x@example.test>", T0)
    with pytest.raises(SmtpError) as err:
        await smtp_service.deliver(account, SMTP_PASSWORD, msg, timeout=2)
    assert (err.value.code, err.value.uncertain) == ("smtp_unavailable", False)


async def test_check_connection_logs_in_without_sending(fake_smtp):
    handler, account = fake_smtp()
    await smtp_service.check_connection(account, SMTP_PASSWORD, timeout=5)
    with pytest.raises(SmtpError) as err:
        await smtp_service.check_connection(account, "wrong", timeout=5)
    assert err.value.code == "smtp_auth_failed"
    assert handler.envelopes == []


async def test_deliver_refuses_a_private_host_without_the_switch(monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", False)
    account = SmtpAccount("127.0.0.1", 2525, SMTP_USER, SENDER)
    msg = smtp_service.build_message(email_doc(), account, "<x@example.test>", T0)
    with patch.object(smtp_service.aiosmtplib, "SMTP", side_effect=AssertionError("must not connect")):
        with pytest.raises(SmtpError) as err:
            await smtp_service.deliver(account, SMTP_PASSWORD, msg, timeout=2)
    assert err.value.code == "smtp_host_blocked"


def test_tls_is_required_unless_private_hosts_are_allowed(monkeypatch):
    monkeypatch.setattr(smtp_service.settings, "smtp_allow_private_hosts", False)
    assert smtp_service._client(ACCOUNT, 5)._start_tls_on_connect is True
    implicit = smtp_service._client(SmtpAccount("h", 465, "u", SENDER), 5)
    assert implicit.use_tls is True
