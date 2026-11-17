"""Rules of the real send of prospecting emails (RF-VTA-16) that do not
depend on how the email travels: the two switches and the body as it is sent.
Pure; no I/O."""
from __future__ import annotations

from typing import Any, Mapping, Optional

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


def body_as_sent(body: Any, language: Optional[str]) -> str:
    """The body exactly as it is sent: the stored body plus the opt-out line
    in the email's language (never written by the model)."""
    return f"{str(body or '').rstrip()}\n\n{unsubscribe_line_for(language)}\n"
