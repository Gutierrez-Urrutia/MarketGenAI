"""Rules of the real send of prospecting emails (RF-VTA-16) that do not
depend on how the email travels: the two switches and the body as it is sent.
Pure; no I/O."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

from app.config import settings
from app.schemas.outreach_email import unsubscribe_line_for


def server_send_enabled() -> bool:
    """The deployment's master switch (OUTREACH_REAL_SEND_ENABLED)."""
    return bool(settings.outreach_real_send_enabled)


def user_send_enabled(config: Optional[Mapping[str, Any]]) -> bool:
    """The user's own switch, in their pipeline config."""
    return bool((config or {}).get("outreach_real_send_enabled"))


def real_send_enabled(config: Optional[Mapping[str, Any]]) -> bool:
    """Both switches on: the server's and the user's."""
    return server_send_enabled() and user_send_enabled(config)


# -- Sandbox: every email goes to the team's own addresses ----------------------------------------------------------
class RedirectMisconfigured(Exception):
    """OUTREACH_REDIRECT_TO is set but holds no valid address (or a malformed one): sending must stop."""


_ADDRESS = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")


def redirect_addresses() -> Optional[List[str]]:
    """The addresses every email is delivered to in a sandbox environment, or None when real sending applies (the
    setting is empty). Lower-cased, without duplicates. RedirectMisconfigured when the setting is set but any part
    of it is not an address: better no email than one to a real prospect."""
    raw = str(settings.outreach_redirect_to or "").strip()
    if not raw:
        return None
    parts = [part.strip().lower() for part in re.split(r"[,;\s]+", raw) if part.strip()]
    if not parts or any(not _ADDRESS.match(part) for part in parts):
        raise RedirectMisconfigured()
    return list(dict.fromkeys(parts))


_SANDBOX_NOTE = {
    "es": "[Entorno de pruebas: este correo iba dirigido a {to}]",
    "en": "[Test environment: this email was addressed to {to}]",
    "pt": "[Ambiente de testes: este e-mail era destinado a {to}]",
}


def delivery_for(
    claimed: Mapping[str, Any], redirect: Optional[Sequence[str]],
) -> Dict[str, Union[str, List[str]]]:
    """What goes out for an email, given the sandbox addresses (None = real sending):
    {"to": recipient(s), "subject", "body"}. Without a redirect: the contact's address, the stored subject and
    the body as it is sent. With it: the redirect addresses, the subject prefixed with [PRUEBA] and a first line
    that says who the email was meant for (so nobody mistakes a test for a real message). Pure."""
    real_to = str(claimed.get("to_email") or "").strip()
    subject = " ".join(str(claimed.get("subject") or "").split())
    body = body_as_sent(claimed.get("body"), claimed.get("language"))
    if redirect is None:
        return {"to": real_to, "subject": subject, "body": body}
    language = str(claimed.get("language") or "es").lower()
    note = _SANDBOX_NOTE.get(language, _SANDBOX_NOTE["es"]).format(to=real_to)
    return {"to": list(redirect), "subject": f"[PRUEBA] {subject}".strip(), "body": f"{note}\n\n{body}"}


def body_as_sent(body: Any, language: Optional[str]) -> str:
    """The body exactly as it is sent: the stored body plus the opt-out line
    in the email's language (never written by the model)."""
    return f"{str(body or '').rstrip()}\n\n{unsubscribe_line_for(language)}\n"
