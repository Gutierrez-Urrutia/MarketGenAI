"""Mailbox connection (RF-VTA-16): API shapes. No token, code, state or PKCE
verifier ever appears in a response."""
from __future__ import annotations

from datetime import datetime
from typing import Dict, Literal, Optional

from pydantic import BaseModel


class MailConnectionStartRequest(BaseModel):
    """Which mailbox to connect. No body means Microsoft, as before Gmail existed."""

    provider: Literal["microsoft", "google"] = "microsoft"


class MailConnectionStart(BaseModel):
    """Where the browser goes to consent (Microsoft's authorization page)."""

    authorize_url: str


class MailConnectionStatus(BaseModel):
    # Whether the server has an app registration to connect with at all (any provider), and per provider.
    oauth_configured: bool
    providers: Dict[str, bool] = {}
    # "microsoft" | "google" of the connected mailbox (None when not connected).
    provider: Optional[str] = None
    connected: bool
    # Set when the tokens no longer work (revoked, expired, unreadable):
    # sending stays blocked until the user connects again.
    needs_reconnect: bool = False
    address: Optional[str] = None
    display_name: Optional[str] = None
    connected_at: Optional[datetime] = None


class MailConnectionTest(BaseModel):
    """POST /mail-connection/test: the mailbox answered; nothing was sent."""

    ok: bool
    address: str
    display_name: str = ""
