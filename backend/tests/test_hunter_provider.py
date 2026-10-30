"""Tests for hunter_provider (RF15, Agente 2). Every Hunter response here is
simulated (httpx.AsyncClient.stream is patched, DNS is faked) and every
name, address and domain is invented."""
from __future__ import annotations

import json
import logging
import socket
from datetime import datetime, timezone
from unittest.mock import patch

import httpx
import pytest
from cryptography.fernet import Fernet

from app.core import url_safety
from app.core.pipeline_constants import (
    HUNTER_ACCOUNT_URL,
    HUNTER_COMPANY_MATCH_MIN,
    HUNTER_DEPARTMENTS,
    HUNTER_DOMAIN_SEARCH_URL,
    HUNTER_MAX_RESPONSE_BYTES,
    HUNTER_MAX_SOURCE_URLS,
    HUNTER_RESULTS_LIMIT,
    HUNTER_SENIORITY,
)
from app.services import encryption_service, hunter_provider
from app.services.company_domain_validation_service import domain_name_match
from app.services.enrichment_service import EnrichmentService
from app.services.hunter_provider import (
    HunterAuthError,
    HunterHTTPError,
    HunterNoCreditsError,
    HunterNotConfiguredError,
    HunterProvider,
    HunterRateLimitError,
    HunterResponseError,
    HunterTimeoutError,
    from_pipeline_config,
)
from tests.test_job_scout_service import _FailingStreamCtx, _FakeStreamCtx, _stream_response

API_KEY = "hunter-test-key-0000"


@pytest.fixture(autouse=True)
def _fake_dns():
    """safe_get_bytes resolves the (fixed) Hunter host: resolve it to a public IP."""
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo):
        yield


# ── Fake Hunter ───────────────────────────────────────────────────────────────
def email(**overrides) -> dict:
    base = {
        "value": "ana.ruiz@example.com",
        "type": "personal",
        "confidence": 94,
        "first_name": "Ana",
        "last_name": "Ruiz",
        "position": "Head of Operations",
        "seniority": "executive",
        "department": "operations",
        "linkedin": "https://www.linkedin.com/in/ana-ruiz-example",
        "sources": [
            {"domain": "example.com", "uri": "https://example.com/team", "extracted_on": "2025-01-10",
             "last_seen_on": "2026-03-02", "still_on_page": True},
            {"domain": "example.org", "uri": "https://example.org/news/1", "extracted_on": "2024-11-01",
             "last_seen_on": "2025-06-15", "still_on_page": False},
        ],
        "verification": {"date": "2026-02-20", "status": "valid"},
    }
    base.update(overrides)
    return base


def search_body(emails: list, *, domain="example.com", organization="Example Holdings") -> bytes:
    return json.dumps({
        "data": {"domain": domain, "organization": organization, "pattern": "{first}.{last}",
                 "accept_all": False, "emails": emails},
        "meta": {"results": len(emails), "limit": HUNTER_RESULTS_LIMIT, "offset": 0},
    }).encode()


def account_body(remaining=48.0, *, bucket="credits") -> bytes:
    counts = {"used": 2.0, "available": 50.0, "remaining": remaining}
    return json.dumps({"data": {"requests": {bucket: counts}}}).encode()


def error_body(details: str, code: int) -> bytes:
    return json.dumps({"errors": [{"id": "error", "code": code, "details": details}]}).encode()


class FakeHunter:
    """Answers /account and /domain-search with (status, body) or an
    exception raised on connect; a list answers successive calls in order."""

    def __init__(self, search=None, account=(200, account_body())):
        self.answers = {HUNTER_ACCOUNT_URL: account, HUNTER_DOMAIN_SEARCH_URL: search or (200, search_body([email()]))}
        self.calls = []

    def calls_to(self, url):
        return [c for c in self.calls if c["url"] == url]

    def __enter__(self):
        fake = self

        def fake_stream(client, method, url, headers=None, params=None, **kwargs):
            fake.calls.append({"url": str(url), "headers": dict(headers or {}), "params": dict(params or {})})
            answer = fake.answers[str(url)]
            if isinstance(answer, list):
                answer = answer.pop(0)
            if isinstance(answer, BaseException):
                return _FailingStreamCtx(answer)
            status_code, content = answer
            return _FakeStreamCtx(_stream_response(status_code, content=content, url=str(url)))

        self._patch = patch.object(httpx.AsyncClient, "stream", fake_stream)
        self._patch.start()
        return self

    def __exit__(self, *exc_info):
        self._patch.stop()
        return False


async def search(fake: FakeHunter, provider: HunterProvider | None = None, company="Example Holdings", domain="example.com"):
    with fake:
        return await (provider or HunterProvider(API_KEY)).search(company, "Data Entry", domain=domain)


# ── Constants and the company-name threshold ──────────────────────────────────
def test_constants():
    assert HUNTER_DOMAIN_SEARCH_URL == "https://api.hunter.io/v2/domain-search"
    assert HUNTER_ACCOUNT_URL == "https://api.hunter.io/v2/account"
    assert HUNTER_RESULTS_LIMIT == 10
    assert HUNTER_SENIORITY == ("senior", "executive")
    assert HUNTER_DEPARTMENTS == ("executive", "management", "operations", "support", "procurement", "finance", "it")
    assert HUNTER_COMPANY_MATCH_MIN == 0.7


# Public company names and their real domains, measured for the threshold.
@pytest.mark.parametrize("domain, name", [
    ("hsbc.com", "HSBC Global Services"),
    ("uniqlo.com", "Uniqlo"),
    ("zigup.com", "ZIGUP plc"),
    ("britishairways.com", "British Airways"),
])
def test_matching_company_names_pass_the_threshold(domain, name):
    assert domain_name_match(domain, name) >= HUNTER_COMPANY_MATCH_MIN


@pytest.mark.parametrize("domain, name", [
    ("hsbc.com", "Uniqlo"),
    ("uniqlo.com", "British Airways"),
    ("zigup.com", "HSBC Global Services"),
    ("britishairways.com", "ZIGUP plc"),
    ("hsbc.com", "British Airways"),
    ("uniqlo.com", "ZIGUP plc"),
])
def test_unrelated_company_names_stay_below_the_threshold(domain, name):
    assert domain_name_match(domain, name) < HUNTER_COMPANY_MATCH_MIN


# ── Successful search ─────────────────────────────────────────────────────────
async def test_search_by_domain_maps_every_field():
    contacts = await search(FakeHunter())

    assert len(contacts) == 1
    c = contacts[0]
    assert c.full_name == "Ana Ruiz"
    assert c.job_title == "Head of Operations"
    assert c.company == "Example Holdings"
    assert c.email == "ana.ruiz@example.com"
    assert c.linkedin_url == "https://www.linkedin.com/in/ana-ruiz-example"
    assert c.role.value == "unknown"
    assert c.confidence_score == 0.94
    assert c.source == "hunter"
    assert c.email_type == "personal"
    assert c.email_verification_status == "valid"
    assert c.email_verified_at == datetime(2026, 2, 20, tzinfo=timezone.utc)
    assert c.seniority == "executive"
    assert c.department == "operations"
    assert c.source_urls == ["https://example.com/team", "https://example.org/news/1"]
    assert c.source_last_seen_at == datetime(2026, 3, 2, tzinfo=timezone.utc)


async def test_search_sends_the_fixed_url_query_and_key_only_in_the_header():
    fake = FakeHunter()
    await search(fake, domain="https://www.Example.com/about")

    [call] = fake.calls_to(HUNTER_DOMAIN_SEARCH_URL)
    assert call["params"] == {
        "domain": "example.com",  # normalized
        "type": "personal",
        "seniority": "senior,executive",
        "department": "executive,management,operations,support,procurement,finance,it",
        "limit": 10,
        "offset": 0,
    }
    assert call["headers"]["X-API-KEY"] == API_KEY
    for c in fake.calls:
        assert API_KEY not in c["url"]
        assert API_KEY not in json.dumps(c["params"])


async def test_no_department_filter_when_the_constant_is_empty():
    fake = FakeHunter()
    with patch.object(hunter_provider, "HUNTER_DEPARTMENTS", ()):
        await search(fake)
    assert "department" not in fake.calls_to(HUNTER_DOMAIN_SEARCH_URL)[0]["params"]


async def test_no_results_is_an_empty_list_and_spends_no_credit():
    provider = HunterProvider(API_KEY)
    fake = FakeHunter(search=[(200, search_body([])), (200, search_body([]))], account=(200, account_body(1.0)))
    assert await search(fake, provider) == []
    assert await search(fake, provider) == []  # still 1 credit: the second search is made
    assert len(fake.calls_to(HUNTER_DOMAIN_SEARCH_URL)) == 2


async def test_organization_missing_falls_back_to_the_company_name():
    contacts = await search(FakeHunter(search=(200, search_body([email()], organization=None))), company="Example Ltd")
    assert contacts[0].company == "Example Ltd"


async def test_an_invalid_domain_is_searched_by_company_name():
    fake = FakeHunter(search=(200, search_body([email()], domain="example.com")))
    await search(fake, company="Example Holdings", domain="not a domain")
    params = fake.calls_to(HUNTER_DOMAIN_SEARCH_URL)[0]["params"]
    assert "domain" not in params and params["company"] == "Example Holdings"


# ── Search by company name (no domain) ────────────────────────────────────────
async def test_search_by_company_when_there_is_no_domain():
    fake = FakeHunter(search=(200, search_body([email()], domain="example.com")))
    contacts = await search(fake, company="Example Holdings Ltd", domain=None)

    params = fake.calls_to(HUNTER_DOMAIN_SEARCH_URL)[0]["params"]
    assert params["company"] == "Example Holdings Ltd"
    assert "domain" not in params
    assert len(contacts) == 1


async def test_company_search_resolving_to_an_unrelated_domain_is_dropped():
    fake = FakeHunter(search=(200, search_body([email()], domain="example.org")))
    assert domain_name_match("example.org", "Brisa Labs") < HUNTER_COMPANY_MATCH_MIN
    assert await search(fake, company="Brisa Labs", domain=None) == []


async def test_company_search_without_a_resolved_domain_is_dropped():
    fake = FakeHunter(search=(200, search_body([email()], domain=None)))
    assert await search(fake, company="Example Holdings", domain=None) == []


async def test_neither_domain_nor_company_makes_no_request():
    fake = FakeHunter()
    assert await search(fake, company="  ", domain=None) == []
    assert fake.calls == []


# ── Odd fields in an email ────────────────────────────────────────────────────
async def test_null_seniority_verification_and_optional_fields():
    item = email(seniority=None, verification=None, department=None, position=None, linkedin=None,
                 sources=None, type=None, confidence=None)
    [c] = await search(FakeHunter(search=(200, search_body([item]))))
    assert c.seniority is None
    assert c.email_verification_status is None
    assert c.email_verified_at is None
    assert c.department is None
    assert c.job_title == ""
    assert c.linkedin_url is None
    assert c.source_urls == [] and c.source_last_seen_at is None
    assert c.email_type is None
    assert c.confidence_score == 0.0


@pytest.mark.parametrize("raw, expected", [(150, 1.0), (-5, 0.0), ("90", 0.0), (True, 0.0), (55.5, 0.555)])
async def test_confidence_is_scaled_and_clamped(raw, expected):
    [c] = await search(FakeHunter(search=(200, search_body([email(confidence=raw)]))))
    assert c.confidence_score == pytest.approx(expected)


async def test_unknown_email_type_and_non_http_urls_are_dropped_not_the_contact():
    item = email(type="role", linkedin="ana-ruiz-example",
                 sources=[{"uri": "javascript:alert(1)"}, {"uri": "ftp://example.com/x"}, {"uri": "https://example.com/ok"}])
    [c] = await search(FakeHunter(search=(200, search_body([item]))))
    assert c.email_type is None
    assert c.linkedin_url is None
    assert c.source_urls == ["https://example.com/ok"]


async def test_source_urls_are_capped():
    sources = [{"uri": f"https://example.com/page/{i}", "last_seen_on": "2026-01-01"} for i in range(9)]
    [c] = await search(FakeHunter(search=(200, search_body([email(sources=sources)]))))
    assert len(c.source_urls) == HUNTER_MAX_SOURCE_URLS


async def test_emails_without_a_name_or_invalid_are_dropped_and_the_rest_kept(caplog):
    items = [email(first_name="", last_name=None), "not a dict", email(first_name="Tomás", last_name="Vidal",
                                                                       value="tomas.vidal@example.com")]
    with caplog.at_level(logging.WARNING, logger="app.services.hunter_provider"):
        contacts = await search(FakeHunter(search=(200, search_body(items))))
    assert [c.full_name for c in contacts] == ["Tomás Vidal"]
    assert "2 email(s)" in caplog.text


async def test_only_a_first_name_is_enough():
    [c] = await search(FakeHunter(search=(200, search_body([email(last_name=None)]))))
    assert c.full_name == "Ana"


# ── Credits (/account) ────────────────────────────────────────────────────────
async def test_account_is_read_once_per_provider():
    provider = HunterProvider(API_KEY)
    fake = FakeHunter(search=[(200, search_body([email()])), (200, search_body([email()]))])
    await search(fake, provider)
    await search(fake, provider)
    assert len(fake.calls_to(HUNTER_ACCOUNT_URL)) == 1
    assert fake.calls_to(HUNTER_ACCOUNT_URL)[0]["headers"]["X-API-KEY"] == API_KEY


@pytest.mark.parametrize("remaining", [0.0, 0.5])
async def test_no_credits_stops_before_searching(remaining):
    fake = FakeHunter(account=(200, account_body(remaining)))
    with pytest.raises(HunterNoCreditsError):
        await search(fake)
    assert fake.calls_to(HUNTER_DOMAIN_SEARCH_URL) == []


async def test_credits_fall_back_to_searches_remaining():
    fake = FakeHunter(account=(200, account_body(0.0, bucket="searches")))
    with pytest.raises(HunterNoCreditsError):
        await search(fake)


async def test_the_balance_is_counted_down_after_a_search_with_results():
    provider = HunterProvider(API_KEY)
    fake = FakeHunter(account=(200, account_body(1.0)))
    assert len(await search(fake, provider)) == 1
    with pytest.raises(HunterNoCreditsError):
        await search(fake, provider)
    assert len(fake.calls_to(HUNTER_DOMAIN_SEARCH_URL)) == 1


@pytest.mark.parametrize("account", [
    (500, b"oops"),
    (200, b"not json"),
    (200, json.dumps({"data": {}}).encode()),
    httpx.ReadTimeout("slow"),
])
async def test_account_failure_other_than_401_still_searches(account):
    fake = FakeHunter(account=account)
    assert len(await search(fake)) == 1


async def test_account_401_stops_and_is_remembered():
    provider = HunterProvider(API_KEY)
    fake = FakeHunter(account=(401, error_body("Invalid API key", 401)))
    for _ in range(2):
        with pytest.raises(HunterAuthError):
            await search(fake, provider)
    assert len(fake.calls_to(HUNTER_ACCOUNT_URL)) == 1
    assert fake.calls_to(HUNTER_DOMAIN_SEARCH_URL) == []


# ── Errors ────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("answer, error", [
    ((401, error_body("Invalid API key", 401)), HunterAuthError),
    ((429, error_body("Too many requests", 429)), HunterRateLimitError),
    ((400, error_body("Bad domain", 400)), HunterHTTPError),
    ((503, b"<html>down</html>"), HunterHTTPError),
    (httpx.ConnectError("refused"), HunterHTTPError),
    (httpx.ReadTimeout("slow"), HunterTimeoutError),
    ((200, b"not json"), HunterResponseError),
    ((200, b"[1, 2]"), HunterResponseError),
    ((200, json.dumps({"data": None}).encode()), HunterResponseError),
    ((200, json.dumps({"data": {"emails": "x"}}).encode()), HunterResponseError),
    ((200, b" " * HUNTER_MAX_RESPONSE_BYTES), HunterResponseError),
])
async def test_search_errors(answer, error):
    with pytest.raises(error):
        await search(FakeHunter(search=answer))


async def test_missing_key_raises_without_any_request():
    fake = FakeHunter()
    for key in ("", "   ", None):
        with pytest.raises(HunterNotConfiguredError):
            await search(fake, HunterProvider(key))
    assert fake.calls == []


@pytest.mark.parametrize("answer, reason, message", [
    ((401, error_body("Invalid API key", 401)), "error", "el proveedor falló: HunterAuthError"),
    ((429, error_body("Too many requests", 429)), "error", "el proveedor falló: HunterRateLimitError"),
    (httpx.ReadTimeout("slow"), "timeout", "el proveedor superó el tiempo límite"),
    ((200, b"not json"), "error", "el proveedor falló: HunterResponseError"),
])
async def test_errors_become_provider_errors_in_enrichment_service(answer, reason, message):
    with FakeHunter(search=answer):
        result = await EnrichmentService([HunterProvider(API_KEY)]).find_contacts("Example", "x", domain="example.com")
    assert result.contacts == []
    assert [(e.provider, e.reason, e.message) for e in result.errors] == [("hunter", reason, message)]


async def test_no_credits_becomes_a_provider_error():
    with FakeHunter(account=(200, account_body(0.0))):
        result = await EnrichmentService([HunterProvider(API_KEY)]).find_contacts("Example", "x", domain="example.com")
    assert result.errors[0].message == "el proveedor falló: HunterNoCreditsError"


# ── The key never leaks ───────────────────────────────────────────────────────
@pytest.mark.parametrize("search_answer, account_answer", [
    ((401, error_body(f"No user found for the API key supplied: {API_KEY}", 401)), (200, account_body())),
    ((429, error_body(f"Rate limit for {API_KEY}", 429)), (200, account_body())),
    ((200, search_body([email()])), (500, error_body(f"Internal error ({API_KEY})", 500))),
    (httpx.ConnectError(f"refused {API_KEY}"), (200, account_body())),
])
async def test_the_key_never_appears_in_errors_logs_or_repr(caplog, search_answer, account_answer):
    provider = HunterProvider(API_KEY)
    with caplog.at_level(logging.DEBUG):
        with FakeHunter(search=search_answer, account=account_answer):
            result = await EnrichmentService([provider]).find_contacts("Example", "x", domain="example.com")

    assert API_KEY not in caplog.text
    assert API_KEY not in result.model_dump_json()
    assert API_KEY not in repr(provider)
    assert API_KEY not in str(provider)


async def test_echoed_key_is_masked_in_the_logged_detail(caplog):
    with caplog.at_level(logging.WARNING, logger="app.services.hunter_provider"):
        with pytest.raises(HunterAuthError):
            await search(FakeHunter(search=(401, error_body(f"Bad key {API_KEY}", 401))))
    assert "HTTP 401: Bad key ***" in caplog.text


async def test_raised_errors_carry_no_request_or_key():
    with pytest.raises(HunterHTTPError) as info:
        await search(FakeHunter(search=httpx.ConnectError(f"refused {API_KEY}")))
    assert info.value.args == ()
    assert info.value.__suppress_context__ is True


async def test_logs_never_contain_contact_data(caplog):
    with caplog.at_level(logging.DEBUG):
        await search(FakeHunter(search=(200, search_body([email(), email(first_name="", last_name="")]))))
    for fragment in ("Ana", "Ruiz", "ana.ruiz@example.com", "Head of Operations", "linkedin.com/in"):
        assert fragment not in caplog.text


def test_error_detail_helper():
    body = error_body(f"  Key\n {API_KEY}   is invalid  ", 401)
    assert hunter_provider.error_detail(body, API_KEY) == "Key *** is invalid"
    assert hunter_provider.error_detail(b"not json", API_KEY) == ""
    assert hunter_provider.error_detail(json.dumps({"errors": "x"}).encode(), API_KEY) == ""
    assert len(hunter_provider.error_detail(error_body("x" * 500, 400), API_KEY)) == 200


# ── from_pipeline_config: the key is decrypted in memory only ─────────────────
@pytest.fixture
def encryption_key(monkeypatch):
    monkeypatch.setattr("app.services.encryption_service.settings.pipeline_encryption_key", Fernet.generate_key().decode())
    encryption_service._fernet.cache_clear()
    yield
    encryption_service._fernet.cache_clear()


async def test_from_pipeline_config_decrypts_the_stored_key(encryption_key):
    provider = from_pipeline_config({"hunter_api_key_encrypted": encryption_service.encrypt(API_KEY)})
    assert isinstance(provider, HunterProvider)
    fake = FakeHunter()
    await search(fake, provider)
    assert fake.calls_to(HUNTER_DOMAIN_SEARCH_URL)[0]["headers"]["X-API-KEY"] == API_KEY


@pytest.mark.parametrize("config", [{}, {"hunter_api_key_encrypted": ""}, None])
def test_from_pipeline_config_without_a_key_is_none(encryption_key, config):
    assert from_pipeline_config(config) is None


def test_from_pipeline_config_with_an_undecryptable_key_is_none(encryption_key, caplog):
    token = Fernet(Fernet.generate_key()).encrypt(API_KEY.encode()).decode()  # another key
    with caplog.at_level(logging.WARNING):
        assert from_pipeline_config({"hunter_api_key_encrypted": token}) is None
    assert "InvalidToken" in caplog.text
    assert API_KEY not in caplog.text


def test_from_pipeline_config_without_encryption_key_is_none(monkeypatch):
    monkeypatch.setattr("app.services.encryption_service.settings.pipeline_encryption_key", "")
    encryption_service._fernet.cache_clear()
    try:
        assert from_pipeline_config({"hunter_api_key_encrypted": "token"}) is None
    finally:
        encryption_service._fernet.cache_clear()
