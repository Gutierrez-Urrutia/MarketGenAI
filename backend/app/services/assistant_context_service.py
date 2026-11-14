"""Read-only context for the sales & marketing assistant (RF-VTA-09).

The assistant answers questions about the caller's own customers, proposals,
opportunities and about the company's service catalog. Everything is read
here, on the server, with the `user_id` taken from the verified JWT: neither
the client nor the model ever chooses whose data is read, and nothing in this
module writes to Firestore.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List

from app.services.firestore_service import (
    customers_repo,
    opportunities_repo,
    proposals_repo,
    service_catalog_repo,
    service_types_repo,
)

MAX_CUSTOMERS = 100
MAX_PROPOSALS = 50
MAX_OPPORTUNITIES = 50
MAX_SERVICES = 100
MAX_DETAILED = 5          # mentioned proposals / services that get extra detail
MIN_MENTION_LENGTH = 3    # ignore tiny names when looking for mentions
FIELD_MAX_CHARS = 200
DETAIL_MAX_CHARS = 600


def _clean(value: Any, limit: int = FIELD_MAX_CHARS) -> str:
    """One line, bounded, and without the delimiter used around the data block,
    so stored text can not close the block or start a new instruction line."""
    if value is None:
        return ""
    text = re.sub(r"\s+", " ", str(value)).strip()
    text = text.replace("<", "(").replace(">", ")")
    return text[:limit]


def _mentioned(message: str, *names: Any) -> bool:
    haystack = (message or "").lower()
    for name in names:
        needle = _clean(name).lower()
        if len(needle) >= MIN_MENTION_LENGTH and needle in haystack:
            return True
    return False


def _line(*parts: Any) -> str:
    return "- " + " | ".join(p for p in (_clean(x) for x in parts) if p)


def _customers_section(customers: List[Dict[str, Any]]) -> List[str]:
    return [
        _line(c.get("name"), c.get("company"), c.get("email"), c.get("phone"), c.get("notes"))
        for c in customers
    ]


def _proposals_section(proposals: List[Dict[str, Any]], message: str) -> List[str]:
    lines: List[str] = []
    detailed = 0
    for p in proposals:
        currency = p.get("currency") or ""
        amount = p.get("totalAmount")
        lines.append(_line(
            p.get("title"),
            f"client: {p.get('clientName')}" if p.get("clientName") else "",
            f"company: {p.get('clientCompany')}" if p.get("clientCompany") else "",
            f"status: {p.get('proposal_status') or 'borrador'}",
            f"total: {amount} {currency}".strip() if amount not in (None, "") else "",
            f"updated: {p.get('updatedAt')}" if p.get("updatedAt") else "",
        ))
        if detailed < MAX_DETAILED and _mentioned(message, p.get("title"), p.get("clientName"), p.get("clientCompany")):
            description = _clean(p.get("description"), DETAIL_MAX_CHARS)
            if description:
                lines.append(f"  detail: {description}")
            detailed += 1
    return lines


def _opportunities_section(opportunities: List[Dict[str, Any]]) -> List[str]:
    return [
        _line(o.get("company"), o.get("job"), f"contact: {o.get('contact')}" if o.get("contact") else "",
              f"stage: {o.get('stage')}" if o.get("stage") else "",
              f"score: {o.get('score')}" if o.get("score") not in (None, "") else "")
        for o in opportunities
    ]


def _catalog_section(services: List[Dict[str, Any]], types: Dict[str, str], message: str) -> List[str]:
    lines: List[str] = []
    detailed = 0
    for s in services:
        lines.append(_line(
            s.get("name"),
            f"type: {types.get(s.get('typeId'), '')}" if types.get(s.get("typeId")) else "",
            f"unit: {s.get('unit')}" if s.get("unit") else "",
            f"price: {s.get('price')} {s.get('currency') or ''}".strip() if s.get("price") is not None else "",
        ))
        if detailed < MAX_DETAILED and _mentioned(message, s.get("name")):
            for label, key in (("description", "description"), ("conditions", "conditions")):
                text = _clean(s.get(key), DETAIL_MAX_CHARS)
                if text:
                    lines.append(f"  {label}: {text}")
            detailed += 1
    return lines


def _block(title: str, lines: Iterable[str], total: int, shown: int) -> str:
    lines = list(lines)
    header = f"## {title} ({total})" if total == shown else f"## {title} (showing {shown} of {total})"
    return "\n".join([header, *(lines or ["(none)"])])


async def build_context(user_id: str, message: str = "") -> str:
    """Compact text snapshot of the caller's data plus the company catalog.

    Raises nothing for empty collections; a Firestore failure propagates so the
    router can answer with a clear error instead of an answer with no data.
    """
    filters = [("userId", "==", user_id)]
    customers = await customers_repo.list(filters=filters, order_by="createdAt", limit=0)
    proposals = await proposals_repo.list(filters=filters, order_by="updatedAt", limit=0)
    opportunities = await opportunities_repo.list(filters=filters, order_by="createdAt", limit=0)
    services = await service_catalog_repo.list(filters=[("active", "==", True)], limit=0)
    types = {t.get("id"): t.get("name") for t in await service_types_repo.list(limit=0)}

    # Defense in depth: never let a row of another user reach the prompt, even
    # if a repo call above were changed or mocked incorrectly.
    customers = [c for c in customers if c.get("userId") == user_id]
    proposals = [p for p in proposals if p.get("userId") == user_id]
    opportunities = [o for o in opportunities if o.get("userId") == user_id]
    services.sort(key=lambda s: (s.get("name") or "").lower())

    shown_customers = customers[:MAX_CUSTOMERS]
    shown_proposals = proposals[:MAX_PROPOSALS]
    shown_opportunities = opportunities[:MAX_OPPORTUNITIES]
    shown_services = services[:MAX_SERVICES]

    return "\n\n".join([
        _block("Customers", _customers_section(shown_customers), len(customers), len(shown_customers)),
        _block("Proposals", _proposals_section(shown_proposals, message), len(proposals), len(shown_proposals)),
        _block("Opportunities", _opportunities_section(shown_opportunities), len(opportunities), len(shown_opportunities)),
        _block("Service catalog (company-wide, active services)", _catalog_section(shown_services, types, message), len(services), len(shown_services)),
    ])
