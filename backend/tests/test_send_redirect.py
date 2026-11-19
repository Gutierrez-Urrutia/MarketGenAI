"""Sandbox de envío (local y dev): con OUTREACH_REDIRECT_TO definido, TODO correo de prospección sale a las
direcciones del equipo y nunca al contacto real; si el valor está roto, no se envía nada. Se prueba la regla pura y
el envío de punta a punta con Outlook (Graph simulado) y con Gmail (Google simulado). Datos sintéticos."""
from __future__ import annotations

import pytest

from app.core.pipeline_constants import OUTREACH_UNSUBSCRIBE_LINE
from app.services import outreach_send_rules as rules
from tests.fake_google import decode_raw
from tests.test_gmail_connection import configured, world as gmail_world  # noqa: F401  (fixtures)
from tests.test_gmail_connection import send as gmail_send
from tests.test_outreach_emails_send import RECIPIENT, code_of, encryption_key, settings, world as outlook_world  # noqa: F401
from tests.test_outreach_emails_send import send as outlook_send

TEAM = ["pa.gutierrezu@duocuc.cl", "her.lopezs@duocuc.cl", "jor.saavedra@duocuc.cl"]
TEAM_SETTING = "pa.gutierrezu@duocuc.cl, Her.LopezS@duocuc.cl,jor.saavedra@duocuc.cl"


@pytest.fixture
def redirect(monkeypatch):
    monkeypatch.setattr(settings, "outreach_redirect_to", TEAM_SETTING)


# ══ regla pura ═══════════════════════════════════════════════════════════════
def test_without_the_setting_there_is_no_redirect(monkeypatch):
    for empty in ("", "   ", None):
        monkeypatch.setattr(settings, "outreach_redirect_to", empty)
        assert rules.redirect_addresses() is None


@pytest.mark.parametrize("raw", [
    TEAM_SETTING,
    "pa.gutierrezu@duocuc.cl;her.lopezs@duocuc.cl\njor.saavedra@duocuc.cl",
    "PA.GUTIERREZU@duocuc.cl pa.gutierrezu@duocuc.cl her.lopezs@duocuc.cl jor.saavedra@duocuc.cl",
])
def test_the_addresses_are_split_lowercased_and_deduplicated(monkeypatch, raw):
    monkeypatch.setattr(settings, "outreach_redirect_to", raw)
    assert rules.redirect_addresses() == TEAM


@pytest.mark.parametrize("raw", ["sin-arroba", "ok@duocuc.cl, roto", ",,", "a@b", "Ana <ana@duocuc.cl>", "a@@duocuc.cl"])
def test_a_broken_setting_is_refused_never_ignored(monkeypatch, raw):
    monkeypatch.setattr(settings, "outreach_redirect_to", raw)
    with pytest.raises(rules.RedirectMisconfigured):
        rules.redirect_addresses()


CLAIMED = {"to_email": "ana@empresa.example", "subject": "Hola\r\nBcc: x@y.z", "body": "Cuerpo del correo.", "language": "es"}


def test_delivery_without_redirect_is_the_real_one():
    shaped = rules.delivery_for(CLAIMED, None)
    assert shaped["to"] == "ana@empresa.example"
    assert shaped["subject"] == "Hola Bcc: x@y.z"
    assert shaped["body"] == rules.body_as_sent("Cuerpo del correo.", "es")
    assert "[PRUEBA]" not in shaped["subject"] and "Entorno de pruebas" not in shaped["body"]


def test_delivery_with_redirect_goes_to_the_team_and_says_who_it_was_for():
    shaped = rules.delivery_for(CLAIMED, TEAM)
    assert shaped["to"] == TEAM and "ana@empresa.example" not in shaped["to"]
    assert shaped["subject"] == "[PRUEBA] Hola Bcc: x@y.z"
    assert shaped["body"].startswith("[Entorno de pruebas: este correo iba dirigido a ana@empresa.example]\n\nCuerpo")
    assert shaped["body"].rstrip().endswith(OUTREACH_UNSUBSCRIBE_LINE["es"])


@pytest.mark.parametrize("language, fragment", [("en", "Test environment"), ("pt", "Ambiente de testes"), ("xx", "Entorno de pruebas")])
def test_the_test_note_follows_the_email_language(language, fragment):
    assert fragment in rules.delivery_for({**CLAIMED, "language": language}, TEAM)["body"]


# ══ Outlook (Graph) ══════════════════════════════════════════════════════════
async def test_outlook_email_goes_to_the_three_team_addresses_and_not_to_the_contact(client, outlook_world, redirect):
    resp = await outlook_send(client)
    assert resp.status_code == 200, resp.text
    [draft] = outlook_world.ms.drafts_created()
    recipients = [r["emailAddress"]["address"] for r in draft["json"]["toRecipients"]]
    assert recipients == TEAM
    assert RECIPIENT not in recipients
    assert draft["json"]["subject"].startswith("[PRUEBA] ")
    assert RECIPIENT in draft["json"]["body"]["content"].splitlines()[0]          # solo como aviso en la primera línea
    stored = outlook_world.email()
    assert stored["status"] == "sent" and stored["to_email"] == RECIPIENT         # el contacto sigue siendo el original
    last = stored["history"][-1]
    assert last["redirected"] is True and last["delivered_to"] == TEAM


async def test_outlook_without_the_setting_still_sends_to_the_contact(client, outlook_world, monkeypatch):
    monkeypatch.setattr(settings, "outreach_redirect_to", "")
    assert (await outlook_send(client)).status_code == 200
    [draft] = outlook_world.ms.drafts_created()
    assert [r["emailAddress"]["address"] for r in draft["json"]["toRecipients"]] == [RECIPIENT]
    assert "redirected" not in outlook_world.email()["history"][-1]


@pytest.mark.parametrize("raw", ["roto", "a@b", ",,"])
async def test_a_broken_setting_blocks_the_send_and_reserves_nothing(client, outlook_world, monkeypatch, raw):
    monkeypatch.setattr(settings, "outreach_redirect_to", raw)
    resp = await outlook_send(client)
    assert resp.status_code == 503 and code_of(resp) == "send_redirect_misconfigured"
    assert outlook_world.ms.calls == []                                           # nada llegó a Microsoft
    assert outlook_world.email()["status"] == "approved" and "send_lock" not in outlook_world.email()
    assert outlook_world.sent_today() == 0


async def test_the_do_not_contact_list_still_protects_the_real_contact(client, outlook_world, redirect):
    added = await client.post("/api/v1/outreach-emails/do-not-contact", json={"email": RECIPIENT})
    assert added.status_code == 201
    resp = await outlook_send(client)
    assert resp.status_code == 422 and code_of(resp) == "do_not_contact"
    assert outlook_world.ms.calls == []


async def test_the_confirmation_is_still_the_contacts_address(client, outlook_world, redirect):
    resp = await outlook_send(client, confirm="otra@persona.example")
    assert resp.status_code == 409 and code_of(resp) == "recipient_mismatch"
    assert outlook_world.ms.calls == []


# ══ Gmail ════════════════════════════════════════════════════════════════════
async def test_gmail_email_goes_to_the_three_team_addresses_and_not_to_the_contact(client, gmail_world, redirect):
    resp = await gmail_send(client)
    assert resp.status_code == 200, resp.text
    [draft] = gmail_world.g.drafts_created()
    mail = decode_raw(draft["json"]["message"]["raw"])
    assert [a.addr_spec for a in mail["To"].addresses] == TEAM
    assert mail["Cc"] is None and mail["Bcc"] is None
    assert RECIPIENT not in str(mail["To"])
    assert mail["Subject"].startswith("[PRUEBA] ")
    plain = mail.get_body(preferencelist=("plain",)).get_content()
    assert plain.splitlines()[0].startswith("[Entorno de pruebas") and RECIPIENT in plain.splitlines()[0]
    assert RECIPIENT in mail.get_body(preferencelist=("html",)).get_content()
    assert gmail_world.ms.calls == []
    assert gmail_world.email()["history"][-1]["delivered_to"] == TEAM


async def test_gmail_without_the_setting_still_sends_to_the_contact(client, gmail_world, monkeypatch):
    monkeypatch.setattr(settings, "outreach_redirect_to", "")
    assert (await gmail_send(client)).status_code == 200
    mail = decode_raw(gmail_world.g.drafts_created()[0]["json"]["message"]["raw"])
    assert [a.addr_spec for a in mail["To"].addresses] == [RECIPIENT]
    assert not mail["Subject"].startswith("[PRUEBA]")


async def test_gmail_with_a_broken_setting_sends_nothing(client, gmail_world, monkeypatch):
    monkeypatch.setattr(settings, "outreach_redirect_to", "roto")
    resp = await gmail_send(client)
    assert resp.status_code == 503 and code_of(resp) == "send_redirect_misconfigured"
    assert gmail_world.g.calls == [] and gmail_world.g.sent == []


# ══ send-status ══════════════════════════════════════════════════════════════
async def test_send_status_tells_the_ui_that_emails_are_redirected(client, outlook_world, redirect):
    body = (await client.get("/api/v1/outreach-emails/send-status")).json()
    assert body["redirect_active"] is True and body["redirect_to"] == TEAM and body["redirect_misconfigured"] is False


async def test_send_status_without_the_setting(client, outlook_world, monkeypatch):
    monkeypatch.setattr(settings, "outreach_redirect_to", "")
    body = (await client.get("/api/v1/outreach-emails/send-status")).json()
    assert body["redirect_active"] is False and body["redirect_to"] == [] and body["redirect_misconfigured"] is False


async def test_send_status_flags_a_broken_setting(client, outlook_world, monkeypatch):
    monkeypatch.setattr(settings, "outreach_redirect_to", "roto")
    body = (await client.get("/api/v1/outreach-emails/send-status")).json()
    assert body["redirect_active"] is True and body["redirect_misconfigured"] is True and body["redirect_to"] == []
