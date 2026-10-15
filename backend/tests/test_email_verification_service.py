"""Tests for email_verification_service (Fase 3 — Agente 2).

No test touches the network: `_resolve` is replaced by FakeDNS for every test
(autouse), and a query nobody scripted fails the test at teardown — it can't
just be swallowed as an UNKNOWN result."""
from __future__ import annotations

import asyncio
import logging
import time
from types import SimpleNamespace
from unittest.mock import patch

import dns.exception
import dns.name
import dns.resolver
import pytest

from app.services import email_verification_service as svc
from app.services.email_verification_service import EmailStatus, verify_email

DOMAIN = "acme.cl"
EMAIL = f"ana@{DOMAIN}"


def mx(host: str, preference: int = 10):
    return SimpleNamespace(preference=preference, exchange=dns.name.from_text(host))


NULL_MX = SimpleNamespace(preference=0, exchange=dns.name.root)


def lifetime_timeout():
    return dns.resolver.LifetimeTimeout(timeout=1.0, errors=[])


class FakeDNS:
    """Scripted stand-in for `_resolve`. Each (domain, rdtype) maps to an
    answer (a list of records), an exception to raise, or an async callable."""

    def __init__(self):
        self.answers = {}
        self.calls = []
        self.unexpected = []

    def on(self, rdtype, result, domain=DOMAIN):
        self.answers[(domain, rdtype)] = result
        return self

    async def __call__(self, domain, rdtype, lifetime):
        self.calls.append((domain, rdtype, lifetime))
        key = (domain, rdtype)
        if key not in self.answers:
            self.unexpected.append(key)
            raise AssertionError(f"unscripted DNS query {key}")
        result = self.answers[key]
        if isinstance(result, BaseException):
            raise result
        if callable(result):
            return await result()
        return result

    def queried(self):
        return [(domain, rdtype) for domain, rdtype, _ in self.calls]


@pytest.fixture(autouse=True)
def fake_dns():
    fake = FakeDNS()
    with patch.object(svc, "_resolve", new=fake):
        yield fake
    assert not fake.unexpected, f"unscripted DNS queries: {fake.unexpected}"


# ── Invalid input: INVALID / invalid_format, no DNS ───────────────────────────
@pytest.mark.parametrize("value", [
    None,
    123,
    12.5,
    b"ana@acme.cl",
    ["ana@acme.cl"],
    "",
    "   ",
    "a" * 64 + "@" + ".".join(["b" * 60] * 4) + ".cl",  # well-formed shape, > 254 chars
    "ana@acme.cl\n",
    "ana\n@acme.cl",
    "ana@acme.cl\r",
    "\tana@acme.cl",
    "ana@ac\x00me.cl",
    "ana@acme.cl\x7f",
    "ana@acme.cl ",
    "no-at-sign",
    "ana@",
    "@acme.cl",
    "ana@@acme.cl",
    "ana@acme",
    "ana@acme.test",  # reserved / special-use name
])
async def test_odd_input_is_invalid_format_without_dns(fake_dns, value):
    result = await verify_email(value)
    assert result.status == EmailStatus.INVALID
    assert result.reason == "invalid_format"
    assert result.format_valid is False
    assert result.has_mx is None
    assert fake_dns.calls == []


def test_overlong_input_really_is_over_254():
    value = "a" * 64 + "@" + ".".join(["b" * 60] * 4) + ".cl"
    assert len(value) > 254


async def test_invalid_format_keeps_text_input_and_blanks_non_text():
    assert (await verify_email("no-at-sign")).email == "no-at-sign"
    assert (await verify_email(None)).email == ""
    assert (await verify_email(42)).email == ""


async def test_never_raises_with_a_bad_timeout(fake_dns):
    result = await verify_email(EMAIL, timeout=None)
    assert result.status == EmailStatus.UNKNOWN
    assert result.reason == "dns_timeout"
    assert fake_dns.calls == []


@pytest.mark.parametrize("timeout", [0, -1])
async def test_no_budget_left_is_unknown_without_querying(fake_dns, timeout):
    result = await verify_email(EMAIL, timeout=timeout)
    assert (result.status, result.has_mx, result.reason) == (EmailStatus.UNKNOWN, None, "dns_timeout")
    assert fake_dns.calls == []


# ── Normalization and ASCII domain ────────────────────────────────────────────
async def test_surrounding_spaces_are_trimmed(fake_dns):
    fake_dns.on("MX", [mx("mx1.acme.cl.")])
    result = await verify_email(f"  {EMAIL}  ")
    assert result.email == EMAIL
    assert result.status == EmailStatus.VALID


async def test_returns_the_normalized_address(fake_dns):
    fake_dns.on("MX", [mx("mx1.acme.cl.")])
    result = await verify_email("Ana@ACME.cl")
    assert result.email == "Ana@acme.cl"
    assert fake_dns.queried() == [("acme.cl", "MX")]


async def test_queries_the_ascii_domain_of_an_idn(fake_dns):
    fake_dns.on("MX", [mx("mx.xn--bcher-kva.de.")], domain="xn--bcher-kva.de")
    result = await verify_email("ana@bücher.de")
    assert result.status == EmailStatus.VALID
    assert fake_dns.queried() == [("xn--bcher-kva.de", "MX")]
    assert result.email == "ana@bücher.de"


# ── MX outcomes ───────────────────────────────────────────────────────────────
async def test_mx_records_are_valid(fake_dns):
    fake_dns.on("MX", [mx("mx1.acme.cl.", 10), mx("mx2.acme.cl.", 20)])
    result = await verify_email(EMAIL)
    assert (result.status, result.has_mx, result.reason, result.format_valid) == (EmailStatus.VALID, True, "ok", True)
    assert fake_dns.queried() == [(DOMAIN, "MX")]  # no A/AAAA fallback needed


async def test_single_null_mx_is_invalid(fake_dns):
    fake_dns.on("MX", [NULL_MX])
    result = await verify_email(EMAIL)
    assert (result.status, result.has_mx, result.reason) == (EmailStatus.INVALID, False, "null_mx")
    assert fake_dns.queried() == [(DOMAIN, "MX")]  # a null MX is final: no A/AAAA fallback


async def test_null_mx_mixed_with_a_real_mx_is_valid(fake_dns):
    fake_dns.on("MX", [NULL_MX, mx("mx1.acme.cl.")])
    result = await verify_email(EMAIL)
    assert (result.status, result.has_mx, result.reason) == (EmailStatus.VALID, True, "ok")


async def test_nxdomain_is_invalid(fake_dns):
    fake_dns.on("MX", dns.resolver.NXDOMAIN())
    result = await verify_email(EMAIL)
    assert (result.status, result.has_mx, result.reason) == (EmailStatus.INVALID, False, "domain_not_found")
    assert fake_dns.queried() == [(DOMAIN, "MX")]


# ── No MX: implicit MX through A/AAAA ─────────────────────────────────────────
async def test_no_mx_but_a_record_is_valid_without_mx(fake_dns):
    fake_dns.on("MX", dns.resolver.NoAnswer()).on("A", ["203.0.113.10"]).on("AAAA", dns.resolver.NoAnswer())
    result = await verify_email(EMAIL)
    assert (result.status, result.has_mx, result.reason) == (EmailStatus.VALID, False, "implicit_mx_a_record")


async def test_no_mx_but_aaaa_record_is_valid_without_mx(fake_dns):
    fake_dns.on("MX", dns.resolver.NoAnswer()).on("A", dns.resolver.NoAnswer()).on("AAAA", ["2001:db8::10"])
    result = await verify_email(EMAIL)
    assert (result.status, result.has_mx, result.reason) == (EmailStatus.VALID, False, "implicit_mx_a_record")


async def test_no_mx_a_record_wins_even_if_aaaa_times_out(fake_dns):
    fake_dns.on("MX", dns.resolver.NoAnswer()).on("A", ["203.0.113.10"]).on("AAAA", lifetime_timeout())
    result = await verify_email(EMAIL)
    assert result.status == EmailStatus.VALID
    assert result.reason == "implicit_mx_a_record"


async def test_empty_mx_answer_is_treated_like_no_mx(fake_dns):
    fake_dns.on("MX", []).on("A", ["203.0.113.10"]).on("AAAA", dns.resolver.NoAnswer())
    result = await verify_email(EMAIL)
    assert result.reason == "implicit_mx_a_record"


async def test_no_mx_and_no_address_records_is_invalid(fake_dns):
    fake_dns.on("MX", dns.resolver.NoAnswer()).on("A", dns.resolver.NoAnswer()).on("AAAA", dns.resolver.NoAnswer())
    result = await verify_email(EMAIL)
    assert (result.status, result.has_mx, result.reason) == (EmailStatus.INVALID, False, "no_mail_host")
    assert sorted(fake_dns.queried()) == [(DOMAIN, "A"), (DOMAIN, "AAAA"), (DOMAIN, "MX")]


async def test_no_mx_a_nxdomain_and_aaaa_no_answer_is_invalid(fake_dns):
    fake_dns.on("MX", dns.resolver.NoAnswer()).on("A", dns.resolver.NXDOMAIN()).on("AAAA", dns.resolver.NoAnswer())
    result = await verify_email(EMAIL)
    assert (result.status, result.reason) == (EmailStatus.INVALID, "no_mail_host")


async def test_no_mx_no_a_and_aaaa_timeout_is_unknown(fake_dns):
    fake_dns.on("MX", dns.resolver.NoAnswer()).on("A", dns.resolver.NoAnswer()).on("AAAA", lifetime_timeout())
    result = await verify_email(EMAIL)
    assert (result.status, result.has_mx, result.reason) == (EmailStatus.UNKNOWN, None, "dns_timeout")


async def test_no_mx_no_a_and_aaaa_servfail_is_unknown(fake_dns):
    fake_dns.on("MX", dns.resolver.NoAnswer()).on("A", dns.resolver.NoAnswer()).on("AAAA", dns.resolver.NoNameservers())
    result = await verify_email(EMAIL)
    assert (result.status, result.has_mx, result.reason) == (EmailStatus.UNKNOWN, None, "dns_error")


# ── Transient failures on MX: always UNKNOWN, never INVALID ───────────────────
@pytest.mark.parametrize("error, reason", [
    (lifetime_timeout(), "dns_timeout"),
    (dns.exception.Timeout(), "dns_timeout"),
    (TimeoutError(), "dns_timeout"),
    (asyncio.TimeoutError(), "dns_timeout"),
    (dns.resolver.NoNameservers(), "dns_error"),  # how dnspython reports SERVFAIL
    (dns.resolver.YXDOMAIN(), "dns_error"),
    (dns.exception.DNSException(), "dns_error"),
    (OSError("network is unreachable"), "dns_error"),
    (ConnectionResetError(), "dns_error"),
    (RuntimeError("unexpected"), "dns_error"),
])
async def test_transient_mx_failure_is_unknown(fake_dns, error, reason):
    fake_dns.on("MX", error)
    result = await verify_email(EMAIL)
    assert (result.status, result.has_mx, result.reason) == (EmailStatus.UNKNOWN, None, reason)
    assert result.format_valid is True
    assert fake_dns.queried() == [(DOMAIN, "MX")]


# ── Total time budget ─────────────────────────────────────────────────────────
async def test_a_hanging_query_is_cut_at_the_total_budget(fake_dns):
    async def hang():
        await asyncio.sleep(10)

    fake_dns.on("MX", hang)
    started = time.monotonic()
    result = await verify_email(EMAIL, timeout=0.05)
    assert time.monotonic() - started < 1
    assert (result.status, result.reason) == (EmailStatus.UNKNOWN, "dns_timeout")


async def test_budget_is_shared_between_the_mx_and_a_aaaa_queries(fake_dns):
    async def slow_no_answer():
        await asyncio.sleep(0.2)
        raise dns.resolver.NoAnswer()

    fake_dns.on("MX", slow_no_answer).on("A", ["203.0.113.10"]).on("AAAA", dns.resolver.NoAnswer())
    await verify_email(EMAIL, timeout=1.0)

    lifetimes = {rdtype: lifetime for _, rdtype, lifetime in fake_dns.calls}
    assert 0 < lifetimes["MX"] <= 1.0
    # A and AAAA only get what is left after the slow MX query.
    assert 0 < lifetimes["A"] <= 0.85
    assert 0 < lifetimes["AAAA"] <= 0.85


async def test_fallback_is_cut_by_what_is_left_of_the_budget(fake_dns):
    async def slow_no_answer():
        await asyncio.sleep(0.1)
        raise dns.resolver.NoAnswer()

    async def hang():
        await asyncio.sleep(10)

    fake_dns.on("MX", slow_no_answer).on("A", hang).on("AAAA", hang)
    started = time.monotonic()
    result = await verify_email(EMAIL, timeout=0.3)
    elapsed = time.monotonic() - started

    assert (result.status, result.has_mx, result.reason) == (EmailStatus.UNKNOWN, None, "dns_timeout")
    assert sorted(fake_dns.queried()) == [(DOMAIN, "A"), (DOMAIN, "AAAA"), (DOMAIN, "MX")]
    assert elapsed < 1  # the whole check stayed within (about) the 0.3 s budget


# ── Logs never carry the address ──────────────────────────────────────────────
SECRET_LOCAL = "zq-secret-local"
SECRET_EMAIL = f"{SECRET_LOCAL}@{DOMAIN}"


@pytest.mark.parametrize("script, email", [
    ({"MX": [mx("mx1.acme.cl.")]}, SECRET_EMAIL),
    ({"MX": dns.resolver.NXDOMAIN()}, SECRET_EMAIL),
    ({"MX": dns.resolver.NoAnswer(), "A": dns.resolver.NoAnswer(), "AAAA": dns.resolver.NoAnswer()}, SECRET_EMAIL),
    ({"MX": dns.resolver.NoNameservers()}, SECRET_EMAIL),
    ({"MX": RuntimeError(f"boom {SECRET_EMAIL}")}, SECRET_EMAIL),
    ({}, f"{SECRET_LOCAL}@@{DOMAIN}"),
    ({}, f"{SECRET_EMAIL}\n"),
])
async def test_logs_never_contain_the_address(fake_dns, caplog, script, email):
    for rdtype, result in script.items():
        fake_dns.on(rdtype, result)
    caplog.set_level(logging.DEBUG)

    await verify_email(email)

    assert caplog.records, "expected the verification to log its outcome"
    assert SECRET_LOCAL not in caplog.text


# ── Module hygiene ────────────────────────────────────────────────────────────
def test_import_does_not_build_a_resolver():
    # _resolve is patched in every test, so nothing here ever builds one.
    assert svc._resolver is None
