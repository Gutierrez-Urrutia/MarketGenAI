"""Tests for company_domain_validation_service (Fase 3 — T9b). Company
names and domains are invented.

DNS is the same simulated resolver as T2's tests: importing the autouse
`fake_dns` fixture replaces email_verification_service._resolve for every
test here, and an unscripted query fails the test at teardown."""
from __future__ import annotations

import inspect
import logging
from unittest.mock import patch

import dns.resolver
import pytest

from app.core.pipeline_constants import EMAIL_MX_TIMEOUT_SECONDS
from app.services import company_domain_validation_service as svc
from app.services.company_domain_validation_service import (
    DomainValidation,
    domain_name_match,
    validate_company_domain,
)
from app.services.email_verification_service import EmailStatus
from tests.test_email_verification_service import (  # noqa: F401 — fake_dns is an autouse fixture
    NULL_MX,
    fake_dns,
    lifetime_timeout,
    mx,
)

DOMAIN = "nortevial.com"
NAME = "Nortevial Logística SpA"


def outcome(result: DomainValidation):
    return result.status, result.has_mx, result.reason


# ── DNS outcomes (reusing check_domain) ───────────────────────────────────────
async def test_real_mx_is_valid_with_mx(fake_dns):
    fake_dns.on("MX", [mx("mx1.nortevial.com.")], domain=DOMAIN)
    result = await validate_company_domain(DOMAIN, NAME)
    assert outcome(result) == (EmailStatus.VALID, True, "ok")
    assert result.domain == DOMAIN
    assert fake_dns.queried() == [(DOMAIN, "MX")]


async def test_only_a_record_is_valid_without_mx(fake_dns):
    fake_dns.on("MX", dns.resolver.NoAnswer(), domain=DOMAIN)
    fake_dns.on("A", ["203.0.113.10"], domain=DOMAIN).on("AAAA", dns.resolver.NoAnswer(), domain=DOMAIN)
    result = await validate_company_domain(DOMAIN, NAME)
    assert outcome(result) == (EmailStatus.VALID, False, "implicit_mx_a_record")


async def test_only_aaaa_record_is_valid_without_mx(fake_dns):
    fake_dns.on("MX", dns.resolver.NoAnswer(), domain=DOMAIN)
    fake_dns.on("A", dns.resolver.NoAnswer(), domain=DOMAIN).on("AAAA", ["2001:db8::10"], domain=DOMAIN)
    result = await validate_company_domain(DOMAIN, NAME)
    assert outcome(result) == (EmailStatus.VALID, False, "implicit_mx_a_record")


async def test_null_mx_is_invalid(fake_dns):
    # check_domain's verdict, unchanged: the domain says it accepts no mail.
    fake_dns.on("MX", [NULL_MX], domain=DOMAIN)
    result = await validate_company_domain(DOMAIN, NAME)
    assert outcome(result) == (EmailStatus.INVALID, False, "null_mx")


async def test_nxdomain_is_invalid(fake_dns):
    fake_dns.on("MX", dns.resolver.NXDOMAIN(), domain=DOMAIN)
    result = await validate_company_domain(DOMAIN, NAME)
    assert outcome(result) == (EmailStatus.INVALID, False, "domain_not_found")


async def test_no_mx_and_no_address_records_is_invalid(fake_dns):
    fake_dns.on("MX", dns.resolver.NoAnswer(), domain=DOMAIN)
    fake_dns.on("A", dns.resolver.NoAnswer(), domain=DOMAIN).on("AAAA", dns.resolver.NoAnswer(), domain=DOMAIN)
    result = await validate_company_domain(DOMAIN, NAME)
    assert outcome(result) == (EmailStatus.INVALID, False, "no_mail_host")


@pytest.mark.parametrize("error, reason", [
    (lifetime_timeout(), "dns_timeout"),
    (TimeoutError(), "dns_timeout"),
    (dns.resolver.NoNameservers(), "dns_error"),  # SERVFAIL
    (OSError("network is unreachable"), "dns_error"),
])
async def test_transient_dns_failure_is_unknown_never_invalid(fake_dns, error, reason):
    fake_dns.on("MX", error, domain=DOMAIN)
    result = await validate_company_domain(DOMAIN, NAME)
    assert outcome(result) == (EmailStatus.UNKNOWN, None, reason)


# ── Input that is not a normalized company domain: no DNS ────────────────────
@pytest.mark.parametrize("value", [
    None, 123, b"nortevial.com", ["nortevial.com"],
    "", "   ",
    "www.nortevial.com",          # normalize_domain would change it
    "NORTEVIAL.com",
    " nortevial.com",
    "nortevial.com.",
    "https://nortevial.com",
    "careers.nortevial.com",
    "bücherwald.de",              # must arrive as punycode
    "nortevial.github.io",        # platform page
    "jobs.lever.co", "lever.co",  # job board
    "10.0.0.1",
    "localhost",
    "co.uk",
    "mailto:talento@nortevial.com",
])
async def test_input_not_normalized_is_invalid_without_dns(fake_dns, value):
    result = await validate_company_domain(value, NAME)
    assert outcome(result) == (EmailStatus.INVALID, None, "invalid_domain")
    assert fake_dns.calls == []


async def test_punycode_domain_is_accepted(fake_dns):
    fake_dns.on("MX", [mx("mx.xn--bcherwald-q9a.de.")], domain="xn--bcherwald-q9a.de")
    result = await validate_company_domain("xn--bcherwald-q9a.de", "Bücherwald GmbH")
    assert result.status == EmailStatus.VALID
    assert result.name_match == 1.0


# ── name_match never changes the DNS verdict ──────────────────────────────────
@pytest.mark.parametrize("company_name", ["Nortevial", "Kumquat Holdings", "", None, 42])
async def test_name_match_does_not_change_status(fake_dns, company_name):
    fake_dns.on("MX", dns.resolver.NoAnswer(), domain=DOMAIN)
    fake_dns.on("A", ["203.0.113.10"], domain=DOMAIN).on("AAAA", dns.resolver.NoAnswer(), domain=DOMAIN)
    result = await validate_company_domain(DOMAIN, company_name)
    assert outcome(result) == (EmailStatus.VALID, False, "implicit_mx_a_record")


async def test_perfect_name_match_does_not_rescue_an_invalid_domain(fake_dns):
    fake_dns.on("MX", dns.resolver.NXDOMAIN(), domain=DOMAIN)
    result = await validate_company_domain(DOMAIN, "Nortevial")
    assert result.name_match == 1.0
    assert result.status == EmailStatus.INVALID


async def test_unrelated_name_does_not_invalidate_a_valid_domain(fake_dns):
    fake_dns.on("MX", [mx("mx1.nortevial.com.")], domain=DOMAIN)
    result = await validate_company_domain(DOMAIN, "Kumquat")
    assert result.name_match < 0.3
    assert result.status == EmailStatus.VALID


# ── Budget, robustness, logs ──────────────────────────────────────────────────
def test_default_timeout_is_the_email_mx_budget():
    assert inspect.signature(validate_company_domain).parameters["timeout"].default == EMAIL_MX_TIMEOUT_SECONDS


async def test_timeout_reaches_the_dns_queries(fake_dns):
    fake_dns.on("MX", [mx("mx1.nortevial.com.")], domain=DOMAIN)
    await validate_company_domain(DOMAIN, NAME, timeout=1.5)
    (_, _, lifetime), = fake_dns.calls
    assert 0 < lifetime <= 1.5


@pytest.mark.parametrize("timeout", [None, "soon", 0, -1])
async def test_unusable_timeout_never_raises(fake_dns, timeout):
    result = await validate_company_domain(DOMAIN, NAME, timeout=timeout)
    assert outcome(result) == (EmailStatus.UNKNOWN, None, "dns_timeout")
    assert fake_dns.calls == []


async def test_never_raises_on_an_internal_error(fake_dns):
    with patch.object(svc.email_verification_service, "check_domain", side_effect=RuntimeError("boom")):
        result = await validate_company_domain(DOMAIN, NAME)
    assert outcome(result) == (EmailStatus.UNKNOWN, None, "dns_error")


@pytest.mark.parametrize("domain, expected_domain", [(DOMAIN, DOMAIN), (None, "")])
async def test_never_raises_on_an_unexpected_bug(fake_dns, domain, expected_domain):
    with patch.object(svc, "_validate", side_effect=RuntimeError("bug")):
        result = await validate_company_domain(domain, NAME)
    assert outcome(result) == (EmailStatus.UNKNOWN, None, "dns_error")
    assert result.domain == expected_domain


async def test_never_raises_even_if_name_match_breaks(fake_dns):
    fake_dns.on("MX", [mx("mx1.nortevial.com.")], domain=DOMAIN)
    with patch.object(svc, "_name_tokens", side_effect=RuntimeError("boom")):
        result = await validate_company_domain(DOMAIN, NAME)
    assert result.status == EmailStatus.VALID
    assert result.name_match == 0.0


async def test_logs_carry_the_domain_and_reason_but_never_the_company_name(fake_dns, caplog):
    secret_name = "Zoila Secreta Consultores"
    caplog.set_level(logging.DEBUG)
    fake_dns.on("MX", [mx("mx1.nortevial.com.")], domain=DOMAIN)

    await validate_company_domain(DOMAIN, secret_name)
    await validate_company_domain("www.otra-secreta.com", secret_name)  # invalid input path

    assert "nortevial.com" in caplog.text and "ok" in caplog.text
    assert "Zoila" not in caplog.text
    assert "otra-secreta" not in caplog.text  # rejected input is not echoed either


# ── domain_name_match ─────────────────────────────────────────────────────────
@pytest.mark.parametrize("domain, name", [
    ("trackitforward.com", "Track it Forward"),           # words joined in the domain
    ("brisa.com", "Brisa Labs Inc"),                      # legal suffix + one word
    ("brisa.com", "Brisa Labs, Inc."),
    ("cafeterianandu.cl", "Cafetería Ñandú SpA"),         # accents
    ("cafeterianandu.cl", "Cafetería Ñandú S.p.A."),      # dotted legal suffix
    ("qorvanta-apps.com", "Qorvanta Apps"),               # hyphenated domain
    ("brisacode.co.uk", "Brisa Code Ltd"),                # two-level public suffix
    ("xn--bcherwald-q9a.de", "Bücherwald GmbH"),          # punycode label
    ("tallerbit.com", "TALLERBIT CORP"),                  # case
])
def test_name_match_recognizes_the_company(domain, name):
    assert domain_name_match(domain, name) >= 0.9


@pytest.mark.parametrize("name", ["Kumquat", "Zephyr Holdings"])
def test_unrelated_name_is_close_to_zero(name):
    assert domain_name_match("nortevial.com", name) < 0.3


def test_known_limit_unrelated_names_sharing_letters_score_higher():
    # Documented: difflib rewards shared letters, so an unrelated multi-word
    # name can reach ~0.4. name_match is a hint, not a decision.
    assert 0.3 <= domain_name_match("nortevial.com", "Global Logistics Group") < 0.6


@pytest.mark.parametrize("name", ["", "   ", "Inc.", "S.A.", "LLC Ltd Corp", None, 42, ["Nortevial"]])
def test_empty_or_suffix_only_name_is_zero(name):
    assert domain_name_match("nortevial.com", name) == 0.0


@pytest.mark.parametrize("domain", [None, 42, ""])
def test_unusable_domain_is_zero(domain):
    assert domain_name_match(domain, "Nortevial") == 0.0


def test_name_match_is_between_zero_and_one():
    for name in ["Nortevial", "Kumquat", "Nortevial Nortevial Nortevial", "N"]:
        assert 0.0 <= domain_name_match("nortevial.com", name) <= 1.0


def test_legal_suffix_list():
    assert svc.LEGAL_SUFFIXES == {"inc", "llc", "ltd", "ab", "sa", "spa", "corp", "gmbh", "co"}
