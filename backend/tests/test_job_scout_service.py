"""Unit tests for JobScoutService (Agente 1 — Fase 2). All external calls
(httpx, feedparser, DeepSeek, Firestore) are mocked."""
from __future__ import annotations

import json
import socket
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.core import url_safety
from app.schemas.lead import RawJobPosting
from app.services import encryption_service, job_scout_service as svc

PUBLIC_IP = "93.184.216.34"  # example.com's real IP — a stand-in "safe" address
PRIVATE_IP = "10.0.0.5"
METADATA_IP = "169.254.169.254"  # cloud metadata endpoint


def _fake_getaddrinfo(ip: str):
    def _impl(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]
    return _impl


class _FakeStreamCtx:
    """Stand-in for what `httpx.AsyncClient.stream(...)` returns — an async
    context manager yielding a response. url_safety.safe_get_bytes reads
    the body via `response.aiter_bytes()`, which works on a manually
    constructed `httpx.Response(..., content=...)`."""

    def __init__(self, response: httpx.Response):
        self._response = response

    async def __aenter__(self) -> httpx.Response:
        return self._response

    async def __aexit__(self, *exc_info):
        return False


class _FailingStreamCtx:
    """Simulates a connection error raised on entering the stream (this is
    when httpx actually attempts the connection)."""

    def __init__(self, exc: Exception):
        self._exc = exc

    async def __aenter__(self):
        raise self._exc

    async def __aexit__(self, *exc_info):
        return False


def _stream_response(status_code: int, content: bytes = b"", headers: dict | None = None, url: str = "https://x/") -> httpx.Response:
    request = httpx.Request("GET", url)
    return httpx.Response(status_code, content=content, headers=headers or {}, request=request)


@pytest.fixture(autouse=True)
def _fake_dns_resolves_to_public_ip():
    """Tests in this file use placeholder .example.com hosts. Runs the real
    url_safety.validate_url_target logic (scheme check + IP-range block)
    but with DNS resolution mocked to a public IP by default, so tests
    don't depend on network access or real domains resolving. Dedicated
    SSRF tests below override `socket.getaddrinfo` within their own `with`
    block to point at a blocked address instead."""
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=_fake_getaddrinfo(PUBLIC_IP)):
        yield


def fake_source(overrides: dict | None = None) -> dict:
    base = {
        "id": "source-001",
        "name": "JSearch",
        "source_type": "api",
        "enabled": True,
        "config": {"base_url": "https://jsearch.example.com/jobs"},
        "config_encrypted": {},
        "rate_limit": None,
    }
    if overrides:
        base.update(overrides)
    return base


def fake_posting(**overrides) -> RawJobPosting:
    base = dict(
        job_title="Data Entry Specialist",
        company_name="Acme Corp",
        job_description="We need help with back-office data entry.",
        job_url="https://acme.example.com/jobs/1",
        source_id="source-001",
    )
    base.update(overrides)
    return RawJobPosting(**base)


# ── job_url sanitization (XSS: only http/https make it into a Lead) ────────

@pytest.mark.parametrize("unsafe_url", [
    "javascript:alert(document.cookie)",
    "JavaScript:alert(1)",  # scheme match must be case-insensitive
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
])
def test_sanitize_job_url_drops_unsafe_schemes(unsafe_url):
    assert svc._sanitize_job_url(unsafe_url) == ""


@pytest.mark.parametrize("safe_url", [
    "https://acme.example.com/jobs/1",
    "http://acme.example.com/jobs/1",
])
def test_sanitize_job_url_keeps_http_https(safe_url):
    assert svc._sanitize_job_url(safe_url) == safe_url


def test_sanitize_job_url_drops_empty_and_relative():
    assert svc._sanitize_job_url("") == ""
    assert svc._sanitize_job_url("/jobs/1") == ""


@pytest.mark.asyncio
async def test_scan_api_sanitizes_unsafe_job_url():
    source = fake_source()

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        body = json.dumps({"data": [
            {"title": "Ops Manager", "company": "Acme",
             "url": "javascript:alert(document.cookie)"},
        ]}).encode()
        return _FakeStreamCtx(_stream_response(200, content=body, url=url))

    with patch.object(httpx.AsyncClient, "stream", fake_stream):
        postings = await svc._scan_api(source, [])

    assert len(postings) == 1
    assert postings[0].job_url == ""


@pytest.mark.asyncio
async def test_scan_rss_sanitizes_unsafe_job_url():
    source = fake_source({"source_type": "rss", "config": {"feed_url": "https://feed.example.com/rss"}})

    fake_entry = MagicMock()
    fake_entry.title = "Data Entry Clerk at Acme Corp"
    fake_entry.summary = "Some summary"
    fake_entry.link = "javascript:alert(1)"

    fake_parsed = MagicMock()
    fake_parsed.entries = [fake_entry]

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        return _FakeStreamCtx(_stream_response(200, content=b"<rss></rss>", url=url))

    with (
        patch.object(httpx.AsyncClient, "stream", fake_stream),
        patch.object(svc.feedparser, "parse", return_value=fake_parsed),
    ):
        postings = await svc._scan_rss(source, [])

    assert len(postings) == 1
    assert postings[0].job_url == ""


@pytest.mark.asyncio
async def test_scan_scraper_sanitizes_unsafe_job_url():
    source = fake_source({
        "source_type": "scraper",
        "config": {
            "url": "https://jobs.example.com/list",
            "selectors": {"item": ".job", "title": ".title", "company": ".company", "link": "a"},
        },
    })
    html = """
    <html><body>
      <div class="job"><span class="title">Ops Manager</span><span class="company">Acme</span>
        <a href="javascript:alert(1)">link</a></div>
    </body></html>
    """

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        return _FakeStreamCtx(_stream_response(200, content=html.encode(), url=url))

    with (
        patch.object(svc, "_robots_txt_allows", new_callable=AsyncMock, return_value=True),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
        patch.object(svc.asyncio, "sleep", new_callable=AsyncMock),
    ):
        postings = await svc._scan_scraper(source, [])

    assert len(postings) == 1
    assert postings[0].job_url == ""


@pytest.mark.asyncio
async def test_scan_scraper_resolves_relative_link_against_page_url():
    source = fake_source({
        "source_type": "scraper",
        "config": {
            "url": "https://jobs.example.com/list",
            "selectors": {"item": ".job", "title": ".title", "company": ".company", "link": "a"},
        },
    })
    html = """
    <html><body>
      <div class="job"><span class="title">Ops Manager</span><span class="company">Acme</span>
        <a href="/jobs/42">link</a></div>
    </body></html>
    """

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        return _FakeStreamCtx(_stream_response(200, content=html.encode(), url=url))

    with (
        patch.object(svc, "_robots_txt_allows", new_callable=AsyncMock, return_value=True),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
        patch.object(svc.asyncio, "sleep", new_callable=AsyncMock),
    ):
        postings = await svc._scan_scraper(source, [])

    assert postings[0].job_url == "https://jobs.example.com/jobs/42"


# ── compute_fingerprint / dedup scoping ─────────────────────────────────────

def test_compute_fingerprint_is_stable_and_case_insensitive():
    a = svc.compute_fingerprint("Acme Corp", "Data Entry Specialist")
    b = svc.compute_fingerprint("acme corp", "data entry specialist")
    assert a == b
    assert a != svc.compute_fingerprint("Other Corp", "Data Entry Specialist")


@pytest.mark.asyncio
async def test_is_duplicate_scopes_query_by_pipeline_config_id():
    """Two different pipeline configs must be checked independently — the
    same fingerprint existing for config A must not block config B."""
    with patch.object(svc.leads_repo, "list", new_callable=AsyncMock) as mock_list:
        mock_list.return_value = []
        result = await svc._is_duplicate("config-B", ["fp-123"])

    assert result is False
    filters = mock_list.call_args.kwargs["filters"]
    assert ("pipeline_config_id", "==", "config-B") in filters
    assert ("fingerprint", "in", ["fp-123"]) in filters


@pytest.mark.asyncio
async def test_is_duplicate_checks_all_fingerprints_in_one_query_without_repeats():
    with patch.object(svc.leads_repo, "list", new_callable=AsyncMock, return_value=[{"id": "l1"}]) as mock_list:
        result = await svc._is_duplicate("config-1", ["fp-new", "fp-legacy", "fp-new"])

    assert result is True
    mock_list.assert_awaited_once()
    assert ("fingerprint", "in", ["fp-new", "fp-legacy"]) in mock_list.call_args.kwargs["filters"]


# ── Source adapters ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_scan_api_decrypts_api_key_and_sends_bearer_header():
    encryption_service._fernet.cache_clear()
    from cryptography.fernet import Fernet
    key = Fernet.generate_key().decode()
    with patch("app.services.encryption_service.settings.pipeline_encryption_key", key):
        encryption_service._fernet.cache_clear()
        token = encryption_service.encrypt("secret-api-key")

        source = fake_source({"config_encrypted": {"api_key": token}})

        captured_headers = {}

        def fake_stream(self, method, url, headers=None, params=None, **kwargs):
            captured_headers.update(headers or {})
            return _FakeStreamCtx(_stream_response(200, content=b'{"data": []}', url=url))

        with patch.object(httpx.AsyncClient, "stream", fake_stream):
            postings = await svc._scan_api(source, ["BPO"])

        assert postings == []
        assert captured_headers.get("Authorization") == "Bearer secret-api-key"
    encryption_service._fernet.cache_clear()


@pytest.mark.asyncio
async def test_scan_api_falls_back_to_legacy_plaintext_api_key():
    """A source created before commit 92a01c4 may still have api_key in
    plaintext config (config_encrypted empty). The scan must still work —
    not crash, not silently drop the key — using it as-is with a warning."""
    source = fake_source({
        "config": {"base_url": "https://jsearch.example.com/jobs", "api_key": "legacy-plaintext-key"},
        "config_encrypted": {},
    })

    captured_headers = {}

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        captured_headers.update(headers or {})
        return _FakeStreamCtx(_stream_response(200, content=b'{"data": []}', url=url))

    with patch.object(httpx.AsyncClient, "stream", fake_stream):
        postings = await svc._scan_api(source, [])

    assert postings == []
    assert captured_headers.get("Authorization") == "Bearer legacy-plaintext-key"


def test_resolve_source_secrets_prefers_encrypted_over_legacy_plaintext():
    from cryptography.fernet import Fernet
    key = Fernet.generate_key().decode()
    with patch("app.services.encryption_service.settings.pipeline_encryption_key", key):
        encryption_service._fernet.cache_clear()
        token = encryption_service.encrypt("current-key")
        source = fake_source({
            "config": {"base_url": "https://x", "api_key": "stale-plaintext-key"},
            "config_encrypted": {"api_key": token},
        })
        resolved = svc._resolve_source_secrets(source)
    encryption_service._fernet.cache_clear()
    assert resolved["api_key"] == "current-key"


@pytest.mark.asyncio
async def test_scan_api_parses_common_response_shapes():
    source = fake_source()

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        body = json.dumps({"data": [
            {"title": "Ops Manager", "company": "Acme", "description": "x", "url": "https://x"},
        ]}).encode()
        return _FakeStreamCtx(_stream_response(200, content=body, url=url))

    with patch.object(httpx.AsyncClient, "stream", fake_stream):
        postings = await svc._scan_api(source, [])

    assert len(postings) == 1
    assert postings[0].job_title == "Ops Manager"
    assert postings[0].company_name == "Acme"


@pytest.mark.asyncio
async def test_scan_api_returns_empty_on_http_error_without_raising():
    source = fake_source()

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        return _FailingStreamCtx(httpx.ConnectError("boom", request=httpx.Request("GET", url)))

    with patch.object(httpx.AsyncClient, "stream", fake_stream):
        postings = await svc._scan_api(source, [])

    assert postings == []


# ── Response-size cap wiring (mechanism itself is tested in
# test_url_safety.py — these just confirm each call site actually passes
# MAX_SOURCE_RESPONSE_BYTES through) ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_scan_api_passes_max_bytes_cap():
    source = fake_source()
    with patch.object(
        svc.url_safety, "safe_get_bytes", new_callable=AsyncMock, return_value=(200, b'{"data": []}'),
    ) as mock_fetch:
        await svc._scan_api(source, [])
    assert mock_fetch.call_args.kwargs["max_bytes"] == svc.MAX_SOURCE_RESPONSE_BYTES


@pytest.mark.asyncio
async def test_scan_rss_passes_max_bytes_cap():
    source = fake_source({"source_type": "rss", "config": {"feed_url": "https://feed.example.com/rss"}})
    with (
        patch.object(
            svc.url_safety, "safe_get_bytes", new_callable=AsyncMock, return_value=(200, b"<rss></rss>"),
        ) as mock_fetch,
        patch.object(svc.feedparser, "parse", return_value=MagicMock(entries=[])),
    ):
        await svc._scan_rss(source, [])
    assert mock_fetch.call_args.kwargs["max_bytes"] == svc.MAX_SOURCE_RESPONSE_BYTES


@pytest.mark.asyncio
async def test_scan_scraper_passes_max_bytes_cap():
    source = fake_source({
        "source_type": "scraper",
        "config": {"url": "https://jobs.example.com/list", "selectors": {"item": ".job"}},
    })
    with (
        patch.object(svc, "_robots_txt_allows", new_callable=AsyncMock, return_value=True),
        patch.object(
            svc.url_safety, "safe_get_bytes", new_callable=AsyncMock, return_value=(200, b"<html></html>"),
        ) as mock_fetch,
        patch.object(svc.asyncio, "sleep", new_callable=AsyncMock),
    ):
        await svc._scan_scraper(source, [])
    assert mock_fetch.call_args.kwargs["max_bytes"] == svc.MAX_SOURCE_RESPONSE_BYTES


@pytest.mark.asyncio
async def test_robots_txt_allows_passes_max_bytes_cap():
    with patch.object(
        svc.url_safety, "safe_get_bytes", new_callable=AsyncMock, return_value=(200, b""),
    ) as mock_fetch:
        await svc._robots_txt_allows("https://jobs.example.com/list")
    assert mock_fetch.call_args.kwargs["max_bytes"] == svc.MAX_SOURCE_RESPONSE_BYTES


def test_split_rss_title_none_format_never_splits():
    for title in ("Data Entry Clerk at Acme Corp", "Ops Manager - Beta Inc", "Acme: Dev", "Plain title"):
        assert svc._split_rss_title(title, "none") == (title, "")


def test_split_rss_title_unknown_format_never_splits():
    assert svc._split_rss_title("Acme: Dev", "made_up_format") == ("Acme: Dev", "")


@pytest.mark.parametrize("title, expected", [
    ("Acme: Senior Dev", ("Senior Dev", "Acme")),
    # Only the first ": " separates company from title.
    ("Brisa: FULL TIME: Software Engineer Position - Python and SQL",
     ("FULL TIME: Software Engineer Position - Python and SQL", "Brisa")),
    ("  Acme :  Dev  ", ("Dev", "Acme")),
    # Not in the declared format: returned whole, company left empty.
    ("No separator here", ("No separator here", "")),
    ("Ratio 3:1 analyst", ("Ratio 3:1 analyst", "")),
    ("Acme: ", ("Acme:", "")),
    (": Dev", (": Dev", "")),
])
def test_split_rss_title_company_colon_title(title, expected):
    assert svc._split_rss_title(title, "company_colon_title") == expected


def test_legacy_split_rss_title_keeps_old_global_heuristic():
    assert svc._legacy_split_rss_title("Data Entry Clerk at Acme Corp") == ("Data Entry Clerk", "Acme Corp")
    assert svc._legacy_split_rss_title("Ops Manager - Beta Inc") == ("Ops Manager", "Beta Inc")
    assert svc._legacy_split_rss_title("Ops Manager | Beta Inc") == ("Ops Manager", "Beta Inc")
    assert svc._legacy_split_rss_title("Acme: Dev") == ("Acme: Dev", "")


@pytest.mark.parametrize("raw_title, stored_company, stored_title", [
    # Shapes of the leads already in Firestore: most had no separator the
    # heuristic knew, a few were split on " - " at the wrong place.
    ("Acme: Senior Dev", "", "Acme: Senior Dev"),
    ("Tiendita: Software Development Engineer II Full Stack - Payments (Remote @ Peru)",
     "Payments (Remote @ Peru)", "Tiendita: Software Development Engineer II Full Stack"),
])
def test_legacy_rss_fingerprint_reproduces_stored_fingerprint(raw_title, stored_company, stored_title):
    assert svc._legacy_rss_fingerprint(raw_title) == svc.compute_fingerprint(stored_company, stored_title)


def _rss_entry(title, link="https://acme.example.com/jobs/1"):
    entry = MagicMock()
    entry.title = title
    entry.summary = "Some summary"
    entry.link = link
    return entry


async def _scan_rss_with_entries(source, entries):
    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        return _FakeStreamCtx(_stream_response(200, content=b"<rss></rss>", url=url))

    with (
        patch.object(httpx.AsyncClient, "stream", fake_stream),
        patch.object(svc.feedparser, "parse", return_value=MagicMock(entries=entries)),
    ):
        return await svc._scan_rss(source, [])


@pytest.mark.asyncio
async def test_scan_rss_parses_entries():
    source = fake_source({"source_type": "rss", "config": {"feed_url": "https://feed.example.com/rss"}})

    fake_parsed = MagicMock()
    fake_parsed.entries = [_rss_entry("Data Entry Clerk at Acme Corp")]

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        return _FakeStreamCtx(_stream_response(200, content=b"<rss>fake feed bytes</rss>", url=url))

    with (
        patch.object(httpx.AsyncClient, "stream", fake_stream),
        patch.object(svc.feedparser, "parse", return_value=fake_parsed) as mock_parse,
    ):
        postings = await svc._scan_rss(source, [])

    assert len(postings) == 1
    # No title_format on the source: the title is kept whole, no guessing.
    assert postings[0].job_title == "Data Entry Clerk at Acme Corp"
    assert postings[0].company_name == ""
    assert postings[0].raw_title == "Data Entry Clerk at Acme Corp"
    # feedparser must receive bytes fetched by us, never the raw URL — a
    # string argument that isn't a recognized URL makes feedparser treat it
    # as a local file path (see job_scout_service._scan_rss docstring/comment).
    mock_parse.assert_called_once_with(b"<rss>fake feed bytes</rss>")


@pytest.mark.asyncio
async def test_scan_rss_uses_source_title_format():
    source = fake_source({"source_type": "rss", "config": {
        "feed_url": "https://feed.example.com/rss", "title_format": "company_colon_title",
    }})

    postings = await _scan_rss_with_entries(source, [_rss_entry("Acme: Senior Dev")])

    assert len(postings) == 1
    assert postings[0].job_title == "Senior Dev"
    assert postings[0].company_name == "Acme"
    assert postings[0].raw_title == "Acme: Senior Dev"


@pytest.mark.asyncio
async def test_scan_rss_skips_and_logs_entry_without_title(caplog):
    """An entry with an empty/whitespace title is dropped and logged — the
    rest of the feed is still returned, the run is not aborted."""
    source = fake_source({"source_type": "rss", "config": {"feed_url": "https://feed.example.com/rss"}})
    entries = [
        _rss_entry("   ", link="https://acme.example.com/jobs/blank"),
        _rss_entry("Acme: Senior Dev", link="https://acme.example.com/jobs/2"),
    ]

    with caplog.at_level("WARNING", logger="marketgen.pipeline.job_scout"):
        postings = await _scan_rss_with_entries(source, entries)

    assert [p.job_title for p in postings] == ["Acme: Senior Dev"]
    [record] = [r for r in caplog.records if "skipping invalid entry" in r.getMessage()]
    message = record.getMessage()
    assert "jobs/blank" in message
    # The reason says which field failed and why.
    assert "job_title: Value error, job_title must not be empty" in message


@pytest.mark.parametrize("blank", ["", "   "])
def test_raw_job_posting_rejects_blank_title(blank):
    with pytest.raises(ValueError):
        fake_posting(job_title=blank)


def test_raw_job_posting_allows_empty_company_and_strips_title():
    posting = fake_posting(job_title="  Dev  ", company_name="")
    assert posting.job_title == "Dev"
    assert posting.company_name == ""


@pytest.mark.asyncio
async def test_scan_scraper_respects_robots_txt_disallow():
    source = fake_source({
        "source_type": "scraper",
        "config": {"url": "https://jobs.example.com/list", "selectors": {"item": ".job"}},
    })

    with patch.object(svc, "_robots_txt_allows", new_callable=AsyncMock) as mock_robots:
        mock_robots.return_value = False
        postings = await svc._scan_scraper(source, [])

    assert postings == []


@pytest.mark.asyncio
async def test_scan_scraper_extracts_items_via_selectors():
    source = fake_source({
        "source_type": "scraper",
        "config": {
            "url": "https://jobs.example.com/list",
            "selectors": {"item": ".job", "title": ".title", "company": ".company", "link": "a"},
        },
    })
    html = """
    <html><body>
      <div class="job"><span class="title">Ops Manager</span><span class="company">Acme</span>
        <a href="https://jobs.example.com/1">link</a></div>
    </body></html>
    """

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        return _FakeStreamCtx(_stream_response(200, content=html.encode(), url=url))

    with (
        patch.object(svc, "_robots_txt_allows", new_callable=AsyncMock, return_value=True),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
        patch.object(svc.asyncio, "sleep", new_callable=AsyncMock),
    ):
        postings = await svc._scan_scraper(source, [])

    assert len(postings) == 1
    assert postings[0].job_title == "Ops Manager"
    assert postings[0].company_name == "Acme"
    assert postings[0].job_url == "https://jobs.example.com/1"


# ── SSRF protection (app.core.url_safety) ───────────────────────────────────
# These override the module's DNS-mocks-to-public-IP fixture to point the
# source's host at a blocked address instead, and assert the adapter comes
# back empty (its normal "this source failed" outcome) rather than making
# the request — never a crash, never a silent bypass.

@pytest.mark.asyncio
async def test_scan_api_blocks_unsafe_target():
    source = fake_source({"config": {"base_url": "http://internal.example.com/jobs"}})

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        pytest.fail("must not reach the network for a blocked target")

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=_fake_getaddrinfo(METADATA_IP)),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
    ):
        postings = await svc._scan_api(source, [])

    assert postings == []


@pytest.mark.asyncio
async def test_scan_rss_blocks_unsafe_target():
    source = fake_source({"source_type": "rss", "config": {"feed_url": "http://internal.example.com/rss"}})

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        pytest.fail("must not reach the network for a blocked target")

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=_fake_getaddrinfo(PRIVATE_IP)),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
        patch.object(svc.feedparser, "parse") as mock_parse,
    ):
        postings = await svc._scan_rss(source, [])

    assert postings == []
    mock_parse.assert_not_called()


@pytest.mark.asyncio
async def test_scan_scraper_blocks_unsafe_target():
    source = fake_source({
        "source_type": "scraper",
        "config": {"url": "http://internal.example.com/list", "selectors": {"item": ".job"}},
    })

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        pytest.fail("must not reach the network for a blocked target")

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=_fake_getaddrinfo(PRIVATE_IP)),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
    ):
        postings = await svc._scan_scraper(source, [])

    assert postings == []


@pytest.mark.asyncio
async def test_scan_api_blocks_redirect_to_unsafe_target():
    """The initial host resolves safely, but it 302s to an internal host —
    the redirect target must be validated too, not just the original URL."""
    source = fake_source({"config": {"base_url": "https://public.example.com/jobs"}})

    def fake_getaddrinfo(host, port, *args, **kwargs):
        ip = PUBLIC_IP if host == "public.example.com" else PRIVATE_IP
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]

    call_count = {"n": 0}

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        call_count["n"] += 1
        if "public.example.com" in url:
            return _FakeStreamCtx(_stream_response(
                302, headers={"location": "http://internal.example.com/jobs"}, url=url,
            ))
        pytest.fail("redirect target must be blocked before it is ever requested")

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
    ):
        postings = await svc._scan_api(source, [])

    assert postings == []
    assert call_count["n"] == 1  # only the (safe) first hop was ever requested


# ── Relevance scoring ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_score_relevance_batch_happy_path():
    postings = [fake_posting(job_title="A"), fake_posting(job_title="B")]

    async def fake_generate_text(prompt, **kwargs):
        return json.dumps([
            {"id": 0, "relevance_score": 0.9, "matched_keywords": ["BPO"], "reasoning": "x", "suggested_value_prop": "y"},
            {"id": 1, "relevance_score": 0.1, "matched_keywords": [], "reasoning": "x", "suggested_value_prop": "y"},
        ])

    with patch.object(svc.deepseek_service, "generate_text", fake_generate_text):
        results = await svc.score_relevance_batch(postings, ["BPO"])

    assert results[0]["relevance_score"] == 0.9
    assert results[1]["relevance_score"] == 0.1


@pytest.mark.asyncio
async def test_score_relevance_batch_falls_back_to_per_item_on_malformed_response():
    postings = [fake_posting(job_title="A"), fake_posting(job_title="B")]

    calls = {"count": 0}

    async def fake_generate_text(prompt, **kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            # Malformed batch response: text prefix before the JSON array.
            return "not json at all"
        return json.dumps([{"id": 0, "relevance_score": 0.5, "matched_keywords": [], "reasoning": "x"}])

    with patch.object(svc.deepseek_service, "generate_text", fake_generate_text):
        results = await svc.score_relevance_batch(postings, [])

    assert len(results) == 2
    assert calls["count"] == 3  # 1 batch attempt + 2 per-item fallback calls


@pytest.mark.asyncio
async def test_score_relevance_batch_empty_input_returns_empty_without_calling_llm():
    with patch.object(svc.deepseek_service, "generate_text", new_callable=AsyncMock) as mock_llm:
        results = await svc.score_relevance_batch([], [])
    assert results == {}
    mock_llm.assert_not_called()


def test_clean_json_response_strips_markdown_fence():
    raw = "```json\n[{\"id\": 0}]\n```"
    assert svc._clean_json_response(raw) == '[{"id": 0}]'


# ── scan_all_sources orchestration ──────────────────────────────────────────

def fake_pipeline_config(overrides: dict | None = None) -> dict:
    base = {
        "id": "config-1",
        "userId": "user-1",
        "keywords": ["BPO"],
        "excluded_companies": [],
        "sources": [fake_source()],
    }
    if overrides:
        base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_scan_all_sources_persists_leads_above_threshold_only():
    pipeline_config = fake_pipeline_config()

    async def fake_generate_text(prompt, **kwargs):
        return json.dumps([{"id": 0, "relevance_score": 0.9, "matched_keywords": ["BPO"], "reasoning": "x"}])

    with (
        patch.object(svc, "_scan_source", new_callable=AsyncMock, return_value=[fake_posting()]),
        patch.object(svc, "_is_duplicate", new_callable=AsyncMock, return_value=False),
        patch.object(svc.deepseek_service, "generate_text", fake_generate_text),
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock) as mock_create,
    ):
        result = await svc.scan_all_sources(pipeline_config, "run-1")

    assert result["leads_new"] == 1
    assert result["leads_found"] == 1
    assert result["partial"] is False
    mock_create.assert_awaited_once()
    persisted = mock_create.call_args.args[0]
    assert persisted["pipeline_config_id"] == "config-1"
    assert persisted["user_id"] == "user-1"
    assert persisted["pipeline_run_id"] == "run-1"


@pytest.mark.asyncio
async def test_scan_all_sources_skips_leads_below_threshold():
    pipeline_config = fake_pipeline_config()

    async def fake_generate_text(prompt, **kwargs):
        return json.dumps([{"id": 0, "relevance_score": 0.2, "matched_keywords": [], "reasoning": "x"}])

    with (
        patch.object(svc, "_scan_source", new_callable=AsyncMock, return_value=[fake_posting()]),
        patch.object(svc, "_is_duplicate", new_callable=AsyncMock, return_value=False),
        patch.object(svc.deepseek_service, "generate_text", fake_generate_text),
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock) as mock_create,
    ):
        result = await svc.scan_all_sources(pipeline_config, "run-1")

    assert result["leads_new"] == 0
    assert result["leads_found"] == 1
    mock_create.assert_not_awaited()


@pytest.mark.asyncio
async def test_scan_all_sources_skips_duplicates_without_scoring():
    pipeline_config = fake_pipeline_config()

    with (
        patch.object(svc, "_scan_source", new_callable=AsyncMock, return_value=[fake_posting()]),
        patch.object(svc, "_is_duplicate", new_callable=AsyncMock, return_value=True),
        patch.object(svc, "score_relevance_batch", new_callable=AsyncMock) as mock_score,
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock) as mock_create,
    ):
        result = await svc.scan_all_sources(pipeline_config, "run-1")

    assert result["leads_found"] == 0
    assert result["leads_new"] == 0
    mock_score.assert_not_called()
    mock_create.assert_not_awaited()


@pytest.mark.asyncio
async def test_scan_all_sources_skips_posting_matching_a_lead_saved_under_legacy_fingerprint():
    """Regression for the title_format switch: a lead stored before it
    (fingerprint from the old global heuristic) must still block the same
    posting once its source splits titles differently — no duplicate."""
    raw_title = "Tiendita: Software Engineer - Payments (Remote @ Peru)"
    stored_fp = svc.compute_fingerprint("Payments (Remote @ Peru)", "Tiendita: Software Engineer")
    posting = fake_posting(
        job_title="Software Engineer - Payments (Remote @ Peru)",
        company_name="Tiendita",
        raw_title=raw_title,
    )

    async def fake_list(filters=None, **kwargs):
        wanted = dict((field, value) for field, _, value in filters)["fingerprint"]
        return [{"id": "old-lead"}] if stored_fp in wanted else []

    with (
        patch.object(svc, "_scan_source", new_callable=AsyncMock, return_value=[posting]),
        patch.object(svc.leads_repo, "list", side_effect=fake_list),
        patch.object(svc, "score_relevance_batch", new_callable=AsyncMock) as mock_score,
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock) as mock_create,
    ):
        result = await svc.scan_all_sources(fake_pipeline_config(), "run-1")

    assert result["leads_new"] == 0
    mock_score.assert_not_called()
    mock_create.assert_not_awaited()


@pytest.mark.asyncio
async def test_scan_all_sources_checks_only_new_fingerprint_for_non_rss_posting():
    posting = fake_posting()  # no raw_title — API/scraper postings
    with (
        patch.object(svc, "_scan_source", new_callable=AsyncMock, return_value=[posting]),
        patch.object(svc, "_is_duplicate", new_callable=AsyncMock, return_value=True) as mock_dup,
    ):
        await svc.scan_all_sources(fake_pipeline_config(), "run-1")

    mock_dup.assert_awaited_once_with(
        "config-1", [svc.compute_fingerprint(posting.company_name, posting.job_title)],
    )


@pytest.mark.asyncio
async def test_scan_all_sources_persists_raw_title_and_new_fingerprint():
    posting = fake_posting(job_title="Senior Dev", company_name="Acme", raw_title="Acme: Senior Dev")

    async def fake_generate_text(prompt, **kwargs):
        return json.dumps([{"id": 0, "relevance_score": 0.9, "matched_keywords": [], "reasoning": "x"}])

    with (
        patch.object(svc, "_scan_source", new_callable=AsyncMock, return_value=[posting]),
        patch.object(svc, "_is_duplicate", new_callable=AsyncMock, return_value=False),
        patch.object(svc.deepseek_service, "generate_text", fake_generate_text),
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock) as mock_create,
    ):
        await svc.scan_all_sources(fake_pipeline_config(), "run-1")

    persisted = mock_create.call_args.args[0]
    assert persisted["raw_title"] == "Acme: Senior Dev"
    assert persisted["company_name"] == "Acme"
    assert persisted["fingerprint"] == svc.compute_fingerprint("Acme", "Senior Dev")


@pytest.mark.asyncio
async def test_scan_all_sources_excludes_companies_before_scoring():
    pipeline_config = fake_pipeline_config({"excluded_companies": ["Acme Corp"]})

    with (
        patch.object(svc, "_scan_source", new_callable=AsyncMock, return_value=[fake_posting(company_name="Acme Corp")]),
        patch.object(svc, "score_relevance_batch", new_callable=AsyncMock) as mock_score,
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock) as mock_create,
    ):
        result = await svc.scan_all_sources(pipeline_config, "run-1")

    assert result["leads_found"] == 0
    mock_score.assert_not_called()
    mock_create.assert_not_awaited()


@pytest.mark.asyncio
async def test_scan_all_sources_one_failing_source_does_not_abort_run():
    """A source that raises must be recorded as an error and marked
    partial, but the run must still process the remaining sources."""
    source_a = fake_source({"id": "source-a"})
    source_b = fake_source({"id": "source-b"})
    pipeline_config = fake_pipeline_config({"sources": [source_a, source_b]})

    async def fake_scan_source(source, keywords):
        if source["id"] == "source-a":
            raise RuntimeError("source-a is down")
        return [fake_posting(source_id="source-b")]

    async def fake_generate_text(prompt, **kwargs):
        return json.dumps([{"id": 0, "relevance_score": 0.9, "matched_keywords": [], "reasoning": "x"}])

    with (
        patch.object(svc, "_scan_source", side_effect=fake_scan_source),
        patch.object(svc, "_is_duplicate", new_callable=AsyncMock, return_value=False),
        patch.object(svc.deepseek_service, "generate_text", fake_generate_text),
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock) as mock_create,
    ):
        result = await svc.scan_all_sources(pipeline_config, "run-1")

    assert result["partial"] is True
    assert len(result["errors"]) == 1
    assert result["errors"][0]["source_id"] == "source-a"
    assert result["leads_new"] == 1
    mock_create.assert_awaited_once()


@pytest.mark.asyncio
async def test_scan_all_sources_stops_when_time_budget_exhausted():
    source_a = fake_source({"id": "source-a"})
    source_b = fake_source({"id": "source-b"})
    pipeline_config = fake_pipeline_config({"sources": [source_a, source_b]})

    call_order = []

    async def fake_scan_source(source, keywords):
        call_order.append(source["id"])
        return []

    # First time.monotonic() call is `started_at`; force the loop's very
    # next check to already exceed RUN_TIME_BUDGET_SECONDS.
    times = iter([0.0, svc.RUN_TIME_BUDGET_SECONDS + 1, svc.RUN_TIME_BUDGET_SECONDS + 1])

    with (
        patch.object(svc.time, "monotonic", side_effect=lambda: next(times)),
        patch.object(svc, "_scan_source", side_effect=fake_scan_source),
    ):
        result = await svc.scan_all_sources(pipeline_config, "run-1")

    assert call_order == []  # budget exhausted before the first source runs
    assert result["partial"] is True
