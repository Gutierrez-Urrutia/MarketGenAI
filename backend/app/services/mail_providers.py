"""The mail providers a user can connect (RF-VTA-16): Microsoft 365 / Outlook (graph_client) and Gmail
(gmail_client). Both modules expose the same functions -- oauth_configured, check_endpoints, authorize_url,
exchange_code, refresh, get_me, create_draft, send_draft, get_message_state -- plus PROVIDER and REQUIRED_SCOPES,
so the connection and the sending code do not care which one a user has."""
from __future__ import annotations

from types import ModuleType
from typing import Dict, Tuple

from app.services import gmail_client, graph_client

MICROSOFT = graph_client.PROVIDER
GOOGLE = gmail_client.PROVIDER
PROVIDERS: Tuple[str, ...] = (MICROSOFT, GOOGLE)
DEFAULT_PROVIDER = MICROSOFT  # connections saved before Gmail existed have no `provider` of their own


def normalize(provider: object) -> str:
    """A known provider name, or the default for a missing one. ValueError for an unknown one."""
    name = str(provider or DEFAULT_PROVIDER).strip().lower()
    if name not in PROVIDERS:
        raise ValueError(f"unknown mail provider: {name!r}")
    return name


def client(provider: object) -> ModuleType:
    """The client module of `provider`."""
    return gmail_client if normalize(provider) == GOOGLE else graph_client


def configured() -> Dict[str, bool]:
    """Which providers have their OAuth client set on this server."""
    return {name: bool(client(name).oauth_configured()) for name in PROVIDERS}
