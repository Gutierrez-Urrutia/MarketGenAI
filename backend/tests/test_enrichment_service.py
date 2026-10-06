"""Tests for enrichment_service (Fase 3 — Agente 2 skeleton).

The providers below are fakes and exist only here: the service ships with
no real provider yet."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, List

import pytest

from app.core.pipeline_constants import (
    ENRICHMENT_MAX_CONTACTS_PER_PROVIDER,
    ENRICHMENT_PROVIDER_TIMEOUT_SECONDS,
)
from app.schemas.contact import ContactCreate
from app.services.enrichment_service import (
    BaseProvider,
    EnrichmentService,
    ProviderError,
    RawContact,
    dedupe_key,
    deduplicate,
)


def contact(full_name="Ana García", job_title="Head of Operations", email=None, confidence=0.5, source="fake", **extra):
    return RawContact(
        full_name=full_name, job_title=job_title, company="Acme Corp",
        email=email, confidence_score=confidence, source=source, **extra,
    )


class StaticProvider(BaseProvider):
    """Returns a fixed result (anything — the tests feed it bad data too),
    optionally after a delay."""

    def __init__(self, name: str, result: Any, delay: float = 0.0):
        self.name = name
        self.result = result
        self.delay = delay
        self.calls = []

    async def search(self, company: str, job_context: str) -> List[RawContact]:
        self.calls.append((company, job_context))
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.result


class FailingProvider(BaseProvider):
    def __init__(self, name: str, exc: BaseException):
        self.name = name
        self.exc = exc

    async def search(self, company: str, job_context: str) -> List[RawContact]:
        raise self.exc


class HangingProvider(BaseProvider):
    name = "hanging"

    async def search(self, company: str, job_context: str) -> List[RawContact]:
        await asyncio.sleep(10)
        return []


async def find(*providers, timeout=ENRICHMENT_PROVIDER_TIMEOUT_SECONDS):
    return await EnrichmentService(list(providers), timeout_seconds=timeout).find_contacts("Acme Corp", "Data Entry")


# ── Schema alignment ──────────────────────────────────────────────────────────
def test_raw_contact_fields_are_contact_create_minus_verified():
    assert set(RawContact.model_fields) == set(ContactCreate.model_fields) - {"verified"}


def test_raw_contact_maps_onto_contact_create():
    raw = contact(email="ana@acme.cl", linkedin_url="https://linkedin.com/in/ana", role="hr_recruiter")
    created = ContactCreate.model_validate(raw.model_dump())
    assert created.model_dump(exclude={"verified"}) == raw.model_dump()
    assert created.verified is False


def test_base_provider_requires_search():
    class NoSearch(BaseProvider):
        name = "no-search"

    with pytest.raises(TypeError):
        NoSearch()


def test_constants():
    assert ENRICHMENT_PROVIDER_TIMEOUT_SECONDS == 20
    assert ENRICHMENT_MAX_CONTACTS_PER_PROVIDER == 50


# ── Combining providers ───────────────────────────────────────────────────────
async def test_no_providers_gives_an_empty_result():
    result = await find()
    assert result.contacts == [] and result.errors == []


async def test_providers_receive_company_and_job_context():
    provider = StaticProvider("one", [])
    await find(provider)
    assert provider.calls == [("Acme Corp", "Data Entry")]


async def test_combines_contacts_from_every_provider():
    a = StaticProvider("a", [contact("Ana", email="ana@acme.cl")])
    b = StaticProvider("b", [contact("Beto", email="beto@acme.cl"), contact("Caro", email="caro@acme.cl")])
    result = await find(a, b)
    assert [c.full_name for c in result.contacts] == ["Ana", "Beto", "Caro"]
    assert result.errors == []


async def test_order_follows_the_provider_list_not_arrival():
    slow_first = StaticProvider("slow", [contact("Ana", email="ana@acme.cl")], delay=0.1)
    fast_second = StaticProvider("fast", [contact("Beto", email="beto@acme.cl")])
    result = await find(slow_first, fast_second)
    assert [c.full_name for c in result.contacts] == ["Ana", "Beto"]


async def test_providers_run_concurrently():
    providers = [StaticProvider(f"p{i}", [], delay=0.2) for i in range(3)]
    started = time.monotonic()
    await find(*providers)
    assert time.monotonic() - started < 0.5  # not 3 x 0.2 one after another


# ── Failure isolation ─────────────────────────────────────────────────────────
async def test_a_failing_provider_does_not_stop_the_others():
    ok = StaticProvider("ok", [contact("Ana", email="ana@acme.cl")])
    broken = FailingProvider("broken", ValueError("bad payload"))
    result = await find(broken, ok)

    assert [c.full_name for c in result.contacts] == ["Ana"]
    assert result.errors == [ProviderError(provider="broken", reason="error", message="el proveedor falló: ValueError")]


async def test_error_message_never_includes_the_exception_text():
    secret = "ana.secreta@acme.cl Ana Secreta"
    result = await find(FailingProvider("broken", RuntimeError(secret)))
    assert result.errors[0].message == "el proveedor falló: RuntimeError"
    assert "ana.secreta" not in result.errors[0].model_dump_json()


async def test_a_slow_provider_is_cut_at_the_timeout_and_the_others_still_return():
    ok = StaticProvider("ok", [contact("Ana", email="ana@acme.cl")])
    started = time.monotonic()
    result = await find(HangingProvider(), ok, timeout=0.05)

    assert time.monotonic() - started < 1
    assert [c.full_name for c in result.contacts] == ["Ana"]
    assert result.errors == [ProviderError(provider="hanging", reason="timeout", message="el proveedor superó el tiempo límite")]


async def test_a_sync_search_is_reported_as_an_error():
    class SyncSearch(BaseProvider):
        name = "sync"

        def search(self, company, job_context):  # not async: a bug in the provider
            return [contact()]

    result = await find(SyncSearch())
    assert result.contacts == []
    assert [(e.provider, e.reason) for e in result.errors] == [("sync", "error")]


async def test_provider_without_name_is_reported_by_class_name():
    class Nameless(BaseProvider):
        async def search(self, company, job_context):
            raise ValueError("x")

    result = await find(Nameless())
    assert result.errors[0].provider == "Nameless"


async def test_cancelled_error_from_a_provider_is_not_swallowed():
    ok = StaticProvider("ok", [contact()])
    with pytest.raises(asyncio.CancelledError):
        await find(ok, FailingProvider("cancelled", asyncio.CancelledError()))


async def test_cancelling_find_contacts_propagates():
    task = asyncio.ensure_future(find(HangingProvider()))
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# ── Invalid provider results ──────────────────────────────────────────────────
@pytest.mark.parametrize("bad, class_name", [
    (None, "NoneType"),
    ({"full_name": "Ana"}, "dict"),
    ((contact(),), "tuple"),
    ("Ana García", "str"),
    (42, "int"),
])
async def test_a_result_that_is_not_a_list_is_ignored_and_reported(bad, class_name):
    ok = StaticProvider("ok", [contact("Beto", email="beto@acme.cl")])
    result = await find(StaticProvider("weird", bad), ok)

    assert [c.full_name for c in result.contacts] == ["Beto"]
    assert result.errors == [ProviderError(
        provider="weird", reason="invalid_result",
        message=f"el proveedor devolvió un resultado inválido: {class_name}",
    )]


async def test_items_that_are_not_raw_contacts_are_dropped_and_the_rest_kept():
    mixed = [
        contact("Ana", email="ana@acme.cl"),
        {"full_name": "Dict Person", "email": "dict@acme.cl"},
        None,
        "Plain String",
        ContactCreate(full_name="Wrong Type", company="Acme", source="x"),
        contact("Beto", email="beto@acme.cl"),
    ]
    result = await find(StaticProvider("mixed", mixed))
    assert [c.full_name for c in result.contacts] == ["Ana", "Beto"]
    assert result.errors == []


async def test_an_empty_list_is_fine():
    result = await find(StaticProvider("empty", []))
    assert result.contacts == [] and result.errors == []


# ── Per-provider cap ──────────────────────────────────────────────────────────
async def test_keeps_only_the_first_50_contacts_of_a_provider(caplog):
    many = [contact(f"Persona {i}", email=f"p{i}@acme.cl") for i in range(ENRICHMENT_MAX_CONTACTS_PER_PROVIDER + 7)]
    other = StaticProvider("other", [contact("Zeta", email="zeta@acme.cl")])
    caplog.set_level(logging.WARNING)

    result = await find(StaticProvider("flood", many), other)

    names = [c.full_name for c in result.contacts]
    assert names[:ENRICHMENT_MAX_CONTACTS_PER_PROVIDER] == [f"Persona {i}" for i in range(ENRICHMENT_MAX_CONTACTS_PER_PROVIDER)]
    assert names[-1] == "Zeta"  # the cap is per provider: the other one is untouched
    assert len(names) == ENRICHMENT_MAX_CONTACTS_PER_PROVIDER + 1
    assert "flood returned 57 contacts; keeping the first 50" in caplog.text


async def test_cap_counts_only_valid_contacts():
    # Invalid items first: capping before filtering would keep only 40 real contacts.
    junk_then_50_valid = [None] * 10 + [contact(f"P{i}", email=f"p{i}@acme.cl") for i in range(50)]
    result = await find(StaticProvider("p", junk_then_50_valid))
    assert len(result.contacts) == 50


# ── Deduplication ─────────────────────────────────────────────────────────────
def test_dedupe_key_uses_lowercased_email():
    assert dedupe_key(contact(email="Ana@ACME.cl")) == ("email", "ana@acme.cl")


def test_dedupe_key_without_email_uses_normalized_name_and_title():
    c = contact(full_name="  Ana   GARCÍA ", job_title="Head  of\tOperations")
    assert dedupe_key(c) == ("name", "ana garcía", "head of operations")


async def test_duplicates_by_email_across_providers_ignore_case():
    a = StaticProvider("a", [contact("Ana", email="Ana@Acme.cl", confidence=0.4)])
    b = StaticProvider("b", [contact("Ana G.", email="ana@acme.cl", confidence=0.4)])
    result = await find(a, b)
    assert [c.full_name for c in result.contacts] == ["Ana"]  # tie: the first one wins


async def test_duplicates_without_email_match_by_name_and_title():
    a = StaticProvider("a", [contact("Ana García", "Head of Operations", confidence=0.3)])
    b = StaticProvider("b", [contact("ana   garcía", "HEAD OF OPERATIONS", confidence=0.3)])
    result = await find(a, b)
    assert len(result.contacts) == 1
    assert result.contacts[0].full_name == "Ana García"


def test_highest_confidence_wins_and_keeps_the_first_position():
    contacts = [
        contact("Ana", email="ana@acme.cl", confidence=0.3, source="a"),
        contact("Beto", email="beto@acme.cl", confidence=0.9),
        contact("Ana García", email="ANA@acme.cl", confidence=0.8, source="b"),
    ]
    result = deduplicate(contacts)
    assert [(c.full_name, c.source) for c in result] == [("Ana García", "b"), ("Beto", "fake")]


def test_on_a_confidence_tie_the_first_one_wins():
    first = contact("Ana", email="ana@acme.cl", confidence=0.5, source="first")
    second = contact("Ana", email="ana@acme.cl", confidence=0.5, source="second")
    assert deduplicate([first, second]) == [first]


def test_same_name_different_title_are_not_duplicates():
    result = deduplicate([contact("Ana", "CTO"), contact("Ana", "CFO")])
    assert len(result) == 2


def test_known_limit_email_and_no_email_versions_are_not_merged():
    # Documented limitation: one provider with the email, another without it.
    result = deduplicate([contact("Ana", "CTO", email="ana@acme.cl"), contact("Ana", "CTO")])
    assert len(result) == 2


# ── Logs never carry contact data ─────────────────────────────────────────────
async def test_logs_never_contain_contact_data(caplog):
    secret_name, secret_email = "Zoila Secreta", "zoila.secreta@acme.cl"
    caplog.set_level(logging.DEBUG)

    await find(
        StaticProvider("flood", [contact(secret_name, email=f"{i}.{secret_email}") for i in range(60)]),
        StaticProvider("mixed", [contact(secret_name, email=secret_email), {"full_name": secret_name}]),
        StaticProvider("weird", {"email": secret_email}),
        FailingProvider("broken", ValueError(f"{secret_name} <{secret_email}>")),
        HangingProvider(),
        timeout=0.05,
    )

    assert caplog.records, "expected warnings for the misbehaving providers"
    assert "Zoila" not in caplog.text
    assert "zoila.secreta" not in caplog.text
