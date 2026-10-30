"""Contact enrichment for Agente 2 (Lead Researcher): pluggable providers.

BaseProvider, RawContact and the service that runs every provider and
merges their results (Fase 3, T3). Providers live in their own modules
(hunter_provider.py); others (a company-site reader...) depend on team
decisions (plan-pipeline-3-agentes.md §4.3).

EnrichmentService.find_contacts:
  - runs all providers concurrently, each capped at
    ENRICHMENT_PROVIDER_TIMEOUT_SECONDS;
  - isolates failures: a provider that raises, times out or returns garbage
    is reported in `errors` and logged, and never stops the others;
  - keeps at most ENRICHMENT_MAX_CONTACTS_PER_PROVIDER contacts per provider;
  - merges in provider-list order (not arrival order) and deduplicates.

Contacts are personal data: logs and ProviderError messages carry provider
names, counts and exception class names only — never contact fields and
never str(exc), which may echo a name or an address back.
"""
from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel

from app.core.pipeline_constants import (
    ENRICHMENT_MAX_CONTACTS_PER_PROVIDER,
    ENRICHMENT_PROVIDER_TIMEOUT_SECONDS,
)
from app.schemas.contact import ContactBase

logger = logging.getLogger(__name__)

MESSAGE_TIMEOUT = "el proveedor superó el tiempo límite"
MESSAGE_ERROR = "el proveedor falló: {exc_class}"
MESSAGE_INVALID_RESULT = "el proveedor devolvió un resultado inválido: {result_class}"


class RawContact(ContactBase):
    """A contact as a provider found it, before it is verified and attached
    to a lead. Same fields as ContactCreate except `verified` — so a
    RawContact maps onto a ContactCreate field for field."""


class BaseProvider(ABC):
    """A source of contacts.

    search() must be truly asynchronous: the per-provider timeout can only
    cut code that awaits. A provider that blocks the event loop (e.g. a
    synchronous `requests` call) cannot be interrupted and would stall
    every other provider with it.

    `domain` is the company's registrable domain when the caller knows it
    (None otherwise). A provider gets plain values only, never the lead."""

    name: str = ""

    @abstractmethod
    async def search(self, company: str, job_context: str, *, domain: Optional[str] = None) -> List[RawContact]:
        ...


class ProviderError(BaseModel):
    provider: str
    reason: Literal["timeout", "error", "invalid_result"]
    message: str  # generic text + exception/result class name; never str(exc)


class EnrichmentResult(BaseModel):
    contacts: List[RawContact]
    errors: List[ProviderError]


# ── Deduplication ─────────────────────────────────────────────────────────────
def _normalize(text: str) -> str:
    return " ".join(text.lower().split())


def dedupe_key(contact: RawContact) -> Tuple[str, ...]:
    """By email (case-insensitive) when there is one; otherwise by name and
    job title, lowercased with whitespace collapsed."""
    if contact.email:
        return ("email", contact.email.strip().lower())
    return ("name", _normalize(contact.full_name), _normalize(contact.job_title))


def deduplicate(contacts: List[RawContact]) -> List[RawContact]:
    """One contact per dedupe_key. The one with the highest confidence_score
    wins (the first one on a tie) and takes the position where that key was
    first seen, so the output order stays deterministic."""
    best: Dict[Tuple[str, ...], RawContact] = {}
    for contact in contacts:
        key = dedupe_key(contact)
        current = best.get(key)
        if current is None or contact.confidence_score > current.confidence_score:
            best[key] = contact  # a dict keeps first-insertion order on reassignment
    return list(best.values())


# ── Service ───────────────────────────────────────────────────────────────────
def _provider_name(provider: Any) -> str:
    return getattr(provider, "name", "") or type(provider).__name__


class EnrichmentService:
    def __init__(
        self,
        providers: List[BaseProvider],
        timeout_seconds: float = ENRICHMENT_PROVIDER_TIMEOUT_SECONDS,
    ):
        self.providers = list(providers)
        self.timeout_seconds = timeout_seconds

    async def find_contacts(self, company: str, job_context: str, *, domain: Optional[str] = None) -> EnrichmentResult:
        outcomes = await asyncio.gather(
            *(self._run_provider(provider, company, job_context, domain) for provider in self.providers),
            return_exceptions=True,
        )
        contacts: List[RawContact] = []
        errors: List[ProviderError] = []
        # gather keeps the order of its arguments: provider-list order, not arrival order.
        for outcome in outcomes:
            if isinstance(outcome, BaseException):
                # _run_provider already turns every Exception into a ProviderError;
                # what is left (CancelledError, KeyboardInterrupt...) is not ours to swallow.
                raise outcome
            found, error = outcome
            contacts.extend(found)
            if error is not None:
                errors.append(error)
        return EnrichmentResult(contacts=deduplicate(contacts), errors=errors)

    async def _run_provider(
        self, provider: BaseProvider, company: str, job_context: str, domain: Optional[str],
    ) -> Tuple[List[RawContact], ProviderError | None]:
        name = _provider_name(provider)
        try:
            result = await asyncio.wait_for(
                provider.search(company, job_context, domain=domain), timeout=self.timeout_seconds,
            )
        except (asyncio.TimeoutError, TimeoutError):
            logger.warning("enrichment: provider %s timed out after %ss", name, self.timeout_seconds)
            return [], ProviderError(provider=name, reason="timeout", message=MESSAGE_TIMEOUT)
        except Exception as exc:
            exc_class = type(exc).__name__
            logger.warning("enrichment: provider %s failed with %s", name, exc_class)
            return [], ProviderError(provider=name, reason="error", message=MESSAGE_ERROR.format(exc_class=exc_class))
        return self._valid_contacts(name, result)

    @staticmethod
    def _valid_contacts(name: str, result: Any) -> Tuple[List[RawContact], ProviderError | None]:
        if not isinstance(result, list):
            result_class = type(result).__name__
            logger.warning("enrichment: provider %s returned %s instead of a list; ignored", name, result_class)
            return [], ProviderError(
                provider=name,
                reason="invalid_result",
                message=MESSAGE_INVALID_RESULT.format(result_class=result_class),
            )

        valid = [item for item in result if isinstance(item, RawContact)]
        dropped = len(result) - len(valid)
        if dropped:
            logger.warning("enrichment: provider %s returned %d item(s) that are not RawContact; dropped", name, dropped)

        if len(valid) > ENRICHMENT_MAX_CONTACTS_PER_PROVIDER:
            logger.warning(
                "enrichment: provider %s returned %d contacts; keeping the first %d",
                name, len(valid), ENRICHMENT_MAX_CONTACTS_PER_PROVIDER,
            )
            valid = valid[:ENRICHMENT_MAX_CONTACTS_PER_PROVIDER]
        return valid, None
