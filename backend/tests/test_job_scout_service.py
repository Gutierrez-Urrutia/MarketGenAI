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


# ── RF13-D-003: una fuente que falla queda registrada en run.errors ─────────
EMPTY_RSS = b'<?xml version="1.0"?><rss version="2.0"><channel><title>QA</title></channel></rss>'


def _rss_source(source_id: str, url: str) -> dict:
    return fake_source({"id": source_id, "name": f"Fuente {source_id}", "source_type": "rss", "config": {"feed_url": url}})


def _stream_by_url(responses: dict):
    """url prefix -> (status, content) or an exception raised on connect."""
    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        for prefix, response in responses.items():
            if str(url).startswith(prefix):
                if isinstance(response, Exception):
                    return _FailingStreamCtx(response)
                status_code, content = response
                return _FakeStreamCtx(_stream_response(status_code, content=content, url=str(url)))
        raise AssertionError(f"unexpected url {url}")
    return fake_stream


async def _scan_with(sources: list, responses: dict) -> dict:
    with (
        patch.object(httpx.AsyncClient, "stream", _stream_by_url(responses)),
        patch.object(svc, "_is_duplicate", new_callable=AsyncMock, return_value=False),
        patch.object(svc, "score_relevance_batch", new_callable=AsyncMock, return_value={}),
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock),
    ):
        return await svc.scan_all_sources(fake_pipeline_config({"sources": sources}), "run-1")


@pytest.mark.asyncio
async def test_scan_all_sources_records_http_error_of_a_source():
    result = await _scan_with(
        [_rss_source("caida", "https://caida.example.com/feed"), _rss_source("vacia", "https://vacia.example.com/feed")],
        {"https://caida.example.com": (404, b"not found"), "https://vacia.example.com": (200, EMPTY_RSS)},
    )
    assert result["partial"] is True
    assert [e["source_id"] for e in result["errors"]] == ["caida"]
    assert result["errors"][0]["source_name"] == "Fuente caida"
    assert "HTTP 404" in result["errors"][0]["message"]
    assert result["all_sources_failed"] is False


@pytest.mark.asyncio
async def test_scan_all_sources_records_network_error_and_all_sources_failed():
    api = fake_source({"id": "api-red", "config": {"base_url": "https://red.example.com/jobs"}})
    result = await _scan_with([api], {"https://red.example.com": httpx.ConnectError("connection refused")})
    assert result["partial"] is True
    assert "error de red" in result["errors"][0]["message"]
    assert result["all_sources_failed"] is True


@pytest.mark.asyncio
async def test_scan_all_sources_records_invalid_content():
    api = fake_source({"id": "api-json", "config": {"base_url": "https://json.example.com/jobs"}})
    result = await _scan_with(
        [api, _rss_source("rss-html", "https://html.example.com/feed")],
        {"https://json.example.com": (200, b"<html>no es json</html>"), "https://html.example.com": (200, b"<html><body>hola</body></html>")},
    )
    mensajes = {e["source_id"]: e["message"] for e in result["errors"]}
    assert "JSON" in mensajes["api-json"]
    assert "feed" in mensajes["rss-html"]


@pytest.mark.asyncio
async def test_scan_all_sources_records_robots_txt_block():
    scraper = fake_source({"id": "scraper-robots", "source_type": "scraper",
                           "config": {"url": "https://robots.example.com/list", "selectors": {"item": ".job"}}})
    with patch.object(svc, "_robots_txt_allows", new_callable=AsyncMock, return_value=False):
        result = await svc.scan_all_sources(fake_pipeline_config({"sources": [scraper]}), "run-1")
    assert "robots.txt" in result["errors"][0]["message"]
    assert result["partial"] is True


@pytest.mark.asyncio
async def test_scan_all_sources_records_truncated_response():
    item = b"<item><title>Acme: Analista</title><link>https://x.example.com/1</link></item>"
    feed = b'<?xml version="1.0"?><rss version="2.0"><channel><title>QA</title>' + item * 40 + b"</channel></rss>"
    with patch.object(svc, "MAX_SOURCE_RESPONSE_BYTES", 1000):
        result = await _scan_with([_rss_source("grande", "https://grande.example.com/feed")],
                                  {"https://grande.example.com": (200, feed)})
    assert any("truncada" in e["message"] for e in result["errors"])
    assert result["partial"] is True


@pytest.mark.asyncio
async def test_finalize_run_marks_failed_when_every_source_failed():
    with patch.object(svc.pipeline_runs_repo, "update", new_callable=AsyncMock) as mock_update:
        await svc.finalize_run("run-1", {"leads_found": 0, "leads_new": 0, "partial": True, "all_sources_failed": True,
                                         "errors": [{"source_id": "a", "message": "HTTP 404"}]})
    assert mock_update.call_args.args[1]["status"] == "failed"


# ── JSearch adapter (RapidAPI: LinkedIn, Indeed, ...) ──────────────────────

JSEARCH_KEY = "jsearch-secret-key-123"


@pytest.fixture
def jsearch_source():
    """A jsearch source whose api_key is encrypted the way the router stores it."""
    from cryptography.fernet import Fernet
    encryption_service._fernet.cache_clear()
    with patch("app.services.encryption_service.settings.pipeline_encryption_key", Fernet.generate_key().decode()):
        encryption_service._fernet.cache_clear()
        token = encryption_service.encrypt(JSEARCH_KEY)

        def _make(config: dict | None = None, source_id: str = "jsearch-1") -> dict:
            return fake_source({
                "id": source_id,
                "name": f"Fuente {source_id}",
                "source_type": "jsearch",
                "config": config or {},
                "config_encrypted": {"api_key": token},
            })
        yield _make
    encryption_service._fernet.cache_clear()


def _jsearch_job(**overrides) -> dict:
    base = {
        "job_title": "Customer Support Agent",
        "employer_name": "Acme Ltd",
        "job_description": "Handle inbound customer tickets.",
        "job_apply_link": "https://acme.example.com/apply/1",
        "job_publisher": "LinkedIn",
        "job_city": "London",
        "job_country": "GB",
    }
    base.update(overrides)
    return base


def _jsearch_body(jobs: list, *, as_list: bool = False, cursor: str | None = "cursor-next") -> bytes:
    """Shape of GET /search-v2: {status, request_id, parameters, data: {jobs, cursor}}."""
    data: object = jobs if as_list else {"jobs": jobs, **({"cursor": cursor} if cursor is not None else {})}
    return json.dumps({"status": "OK", "request_id": "req-1", "parameters": {}, "data": data}).encode()


def _jsearch_stream(pages: list, calls: list):
    """pages[i] answers page i+1: (status, body) or an exception raised on connect."""
    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        calls.append({"url": str(url), "headers": dict(headers or {}), "params": dict(params or {})})
        response = pages[len(calls) - 1]
        if isinstance(response, Exception):
            return _FailingStreamCtx(response)
        status_code, content = response
        return _FakeStreamCtx(_stream_response(status_code, content=content, url=str(url)))
    return fake_stream


async def _scan_jsearch_with(source: dict, pages: list, keywords=("BPO", "customer support")):
    calls: list = []
    problems: list = []
    token = svc._source_problems.set(problems)
    try:
        with patch.object(httpx.AsyncClient, "stream", _jsearch_stream(pages, calls)):
            postings = await svc._scan_jsearch(source, list(keywords))
    finally:
        svc._source_problems.reset(token)
    return postings, calls, problems


@pytest.mark.asyncio
async def test_scan_jsearch_maps_linkedin_indeed_and_apply_options_offers(jsearch_source):
    jobs = [
        _jsearch_job(),
        _jsearch_job(job_title="Back Office Clerk", employer_name="Globex", job_publisher="Indeed",
                     job_apply_link="https://indeed.example.com/viewjob?jk=2", job_description="x" * 1000,
                     job_city=None, job_country=None, job_location="Manchester, UK"),
        _jsearch_job(job_title="Data Entry Operator", employer_name="Initech", job_apply_link=None,
                     apply_options=[{"publisher": "Glassdoor", "apply_link": "https://glassdoor.example.com/3"},
                                    {"publisher": "Other", "apply_link": "https://other.example.com/3"}],
                     job_city="", job_country="", job_location="Anywhere"),
    ]
    postings, calls, problems = await _scan_jsearch_with(jsearch_source(), [(200, _jsearch_body(jobs))])

    assert problems == []
    assert [p.job_title for p in postings] == ["Customer Support Agent", "Back Office Clerk", "Data Entry Operator"]
    assert [p.company_name for p in postings] == ["Acme Ltd", "Globex", "Initech"]
    assert [p.job_url for p in postings] == [
        "https://acme.example.com/apply/1",
        "https://indeed.example.com/viewjob?jk=2",
        "https://glassdoor.example.com/3",
    ]
    assert [p.location for p in postings] == ["London, GB", "Manchester, UK", None]
    assert postings[0].job_description == "Handle inbound customer tickets."
    assert len(postings[1].job_description) == svc.POSTING_DESCRIPTION_MAX_CHARS
    assert all(p.source_id == "jsearch-1" for p in postings)


@pytest.mark.asyncio
@pytest.mark.parametrize("overrides, expected", [
    ({"job_city": "London", "job_country": "GB"}, "London, GB"),
    ({"job_city": "London", "job_country": None, "job_location": "London, England"}, "London, England"),
    ({"job_city": None, "job_country": None, "job_location": "Leeds"}, "Leeds"),
    ({"job_city": "", "job_country": "", "job_location": "Anywhere"}, None),
    ({"job_city": None, "job_country": None, "job_location": "  "}, None),
    ({"job_city": None, "job_country": None}, None),
])
async def test_scan_jsearch_location(jsearch_source, overrides, expected):
    postings, _, _ = await _scan_jsearch_with(jsearch_source(), [(200, _jsearch_body([_jsearch_job(**overrides)]))])
    assert postings[0].location == expected


@pytest.mark.asyncio
async def test_scan_jsearch_drops_offers_without_company_or_title(jsearch_source):
    jobs = [
        _jsearch_job(employer_name=""),
        _jsearch_job(employer_name=None),
        _jsearch_job(job_title="   "),
        _jsearch_job(job_title=None),
        _jsearch_job(job_title="Kept", employer_name="Kept Co"),
    ]
    postings, _, _ = await _scan_jsearch_with(jsearch_source(), [(200, _jsearch_body(jobs))])
    assert [(p.job_title, p.company_name) for p in postings] == [("Kept", "Kept Co")]


@pytest.mark.asyncio
async def test_scan_jsearch_sanitizes_apply_link(jsearch_source):
    jobs = [_jsearch_job(job_apply_link="javascript:alert(1)")]
    postings, _, _ = await _scan_jsearch_with(jsearch_source(), [(200, _jsearch_body(jobs))])
    assert postings[0].job_url == ""


@pytest.mark.asyncio
async def test_scan_jsearch_also_reads_data_as_a_list(jsearch_source):
    postings, _, _ = await _scan_jsearch_with(jsearch_source(), [(200, _jsearch_body([_jsearch_job()], as_list=True))])
    assert len(postings) == 1


@pytest.mark.asyncio
async def test_scan_jsearch_sends_fixed_url_rapidapi_headers_and_query(jsearch_source):
    source = jsearch_source({"base_url": "https://evil.example.com", "country": "us", "language": "es",
                             "date_posted": "week"})
    _, calls, _ = await _scan_jsearch_with(source, [(200, _jsearch_body([_jsearch_job()]))],
                                           keywords=["a", "b", "c", "d", "e", "f"])
    assert len(calls) == 1
    assert calls[0]["url"] == "https://jsearch.p.rapidapi.com/search-v2"
    assert calls[0]["headers"] == {"X-RapidAPI-Key": JSEARCH_KEY, "X-RapidAPI-Host": "jsearch.p.rapidapi.com"}
    # First page: no cursor, and never page/num_pages (search-v2 pages by cursor).
    assert calls[0]["params"] == {"query": "a b c d e", "country": "us", "language": "es", "date_posted": "week"}


@pytest.mark.asyncio
async def test_scan_jsearch_defaults_country_language_and_omits_date_posted(jsearch_source):
    _, calls, _ = await _scan_jsearch_with(jsearch_source(), [(200, _jsearch_body([]))])
    assert calls[0]["params"]["country"] == "gb"
    assert calls[0]["params"]["language"] == "en"
    assert "date_posted" not in calls[0]["params"]


@pytest.mark.asyncio
async def test_scan_jsearch_uses_its_own_45s_timeout(jsearch_source):
    timeouts = []
    real_init = httpx.AsyncClient.__init__

    def spy_init(self, *args, **kwargs):
        timeouts.append(kwargs.get("timeout"))
        real_init(self, *args, **kwargs)

    with patch.object(httpx.AsyncClient, "__init__", spy_init):
        await _scan_jsearch_with(jsearch_source(), [(200, _jsearch_body([]))])
    assert timeouts == [45]


@pytest.mark.asyncio
@pytest.mark.parametrize("num_pages, expected_calls", [(None, 1), (2, 2), (3, 3), (5, 3), (0, 1)])
async def test_scan_jsearch_caps_num_pages(jsearch_source, num_pages, expected_calls):
    config = {} if num_pages is None else {"num_pages": num_pages}
    pages = [(200, _jsearch_body([_jsearch_job(job_title=f"Job {i}")], cursor=f"c{i + 1}")) for i in range(5)]
    postings, calls, _ = await _scan_jsearch_with(jsearch_source(config), pages)
    assert len(calls) == expected_calls
    assert [c["params"].get("cursor") for c in calls] == [None, "c1", "c2"][:expected_calls]
    assert all("page" not in c["params"] and "num_pages" not in c["params"] for c in calls)
    assert len(postings) == expected_calls


@pytest.mark.asyncio
async def test_scan_jsearch_sends_the_previous_cursor_on_page_2(jsearch_source):
    pages = [
        (200, _jsearch_body([_jsearch_job(job_title="Job 1")], cursor="abc123==")),
        (200, _jsearch_body([_jsearch_job(job_title="Job 2")], cursor=None)),
    ]
    postings, calls, problems = await _scan_jsearch_with(jsearch_source({"country": "us", "num_pages": 3}), pages)
    assert len(calls) == 2
    assert "cursor" not in calls[0]["params"]
    assert calls[1]["params"] == {"query": "BPO customer support", "country": "us", "language": "en", "cursor": "abc123=="}
    assert [p.job_title for p in postings] == ["Job 1", "Job 2"]
    assert problems == []


@pytest.mark.asyncio
@pytest.mark.parametrize("cursor", [None, "", "   "])
async def test_scan_jsearch_stops_when_a_page_has_no_cursor(jsearch_source, cursor):
    pages = [(200, _jsearch_body([_jsearch_job()], cursor=cursor)), (200, _jsearch_body([_jsearch_job()]))]
    postings, calls, problems = await _scan_jsearch_with(jsearch_source({"num_pages": 3}), pages)
    assert len(calls) == 1
    assert len(postings) == 1
    assert problems == []


@pytest.mark.asyncio
async def test_scan_jsearch_data_as_a_list_has_no_cursor_so_paging_stops(jsearch_source):
    pages = [(200, _jsearch_body([_jsearch_job()], as_list=True)), (200, _jsearch_body([_jsearch_job()]))]
    postings, calls, _ = await _scan_jsearch_with(jsearch_source({"num_pages": 3}), pages)
    assert (len(calls), len(postings)) == (1, 1)


@pytest.mark.asyncio
async def test_scan_jsearch_stops_paging_on_an_empty_page(jsearch_source):
    pages = [(200, _jsearch_body([_jsearch_job()])), (200, _jsearch_body([])), (200, _jsearch_body([_jsearch_job()]))]
    postings, calls, problems = await _scan_jsearch_with(jsearch_source({"num_pages": 3}), pages)
    assert len(calls) == 2
    assert len(postings) == 1
    assert problems == []


@pytest.mark.asyncio
async def test_scan_jsearch_keeps_at_most_30_postings_and_skips_extra_pages(jsearch_source):
    many = [_jsearch_job(job_title=f"Job {i}") for i in range(40)]
    postings, calls, _ = await _scan_jsearch_with(jsearch_source({"num_pages": 3}), [(200, _jsearch_body(many))] * 3)
    assert len(postings) == svc.MAX_RESULTS_PER_SOURCE == 30
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_scan_jsearch_does_not_request_extra_page_when_run_budget_is_exhausted(jsearch_source):
    pages = [(200, _jsearch_body([_jsearch_job()]))] * 3
    token = svc._run_deadline.set(svc.time.monotonic() - 1)
    try:
        postings, calls, _ = await _scan_jsearch_with(jsearch_source({"num_pages": 3}), pages)
    finally:
        svc._run_deadline.reset(token)
    assert len(calls) == 1
    assert len(postings) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("response, expected", [
    ((403, b'{"message": "You are not subscribed to this API."}'),
     "clave de API inválida o sin suscripción a JSearch (HTTP 403): You are not subscribed to this API."),
    ((429, b'{"message": "Too many requests"}'), "cuota de JSearch agotada (HTTP 429): Too many requests"),
    ((404, b'{"message": "Endpoint \'/search\' does not exist"}'),
     "JSearch respondió HTTP 404: Endpoint '/search' does not exist"),
    ((404, b'{"error": {"code": 404, "message": "Not Found"}}'), "JSearch respondió HTTP 404: Not Found"),
    ((500, b"oops"), "JSearch respondió HTTP 500"),
    ((500, b'{"status": "ERROR"}'), "JSearch respondió HTTP 500"),
    ((200, b"<html>not json</html>"), "la respuesta no es JSON válido"),
    (httpx.ReadTimeout("timed out"), "tiempo de espera agotado (45 s)"),
    (httpx.ConnectError("refused"), "error de red (ConnectError)"),
])
async def test_scan_jsearch_reports_failures_clearly(jsearch_source, caplog, response, expected):
    with caplog.at_level("DEBUG"):
        postings, _, problems = await _scan_jsearch_with(jsearch_source(), [response])
    assert postings == []
    assert problems == [{"message": expected, "fatal": True}]
    assert JSEARCH_KEY not in caplog.text


@pytest.mark.asyncio
async def test_scan_jsearch_provider_reason_is_cut_to_200_chars_and_never_shows_the_key(jsearch_source):
    reason = f"Invalid key {JSEARCH_KEY} " + "x" * 500
    postings, _, problems = await _scan_jsearch_with(
        jsearch_source(), [(401, json.dumps({"message": reason, "headers": {"X-RapidAPI-Key": JSEARCH_KEY}}).encode())],
    )
    message = problems[0]["message"]
    prefix = "JSearch respondió HTTP 401: "
    assert message.startswith(prefix + "Invalid key *** xxx")
    assert len(message) == len(prefix) + 200
    assert JSEARCH_KEY not in message


@pytest.mark.asyncio
async def test_scan_jsearch_failure_on_a_later_page_keeps_earlier_postings(jsearch_source):
    pages = [(200, _jsearch_body([_jsearch_job()])), (429, b"{}")]
    postings, calls, problems = await _scan_jsearch_with(jsearch_source({"num_pages": 3}), pages)
    assert len(postings) == 1
    assert len(calls) == 2
    assert problems == [{"message": "página 2: cuota de JSearch agotada (HTTP 429)", "fatal": False}]


@pytest.mark.asyncio
async def test_scan_jsearch_without_api_key_or_keywords(jsearch_source):
    no_key = jsearch_source()
    no_key["config_encrypted"] = {}
    postings, calls, problems = await _scan_jsearch_with(no_key, [])
    assert (postings, calls) == ([], [])
    assert problems == [{"message": "falta la clave de API (api_key)", "fatal": True}]

    postings, calls, problems = await _scan_jsearch_with(jsearch_source(), [], keywords=["", "  "])
    assert (postings, calls) == ([], [])
    assert problems == [{"message": "no hay palabras clave configuradas para la búsqueda", "fatal": True}]


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code, expected", [
    (403, "clave de API inválida o sin suscripción a JSearch (HTTP 403): nope"),
    (429, "cuota de JSearch agotada (HTTP 429): nope"),
])
async def test_scan_all_sources_jsearch_403_429_do_not_break_the_run(jsearch_source, caplog, status_code, expected):
    sources = [jsearch_source(source_id="js"), _rss_source("vacia", "https://vacia.example.com/feed")]
    responses = {
        "https://jsearch.p.rapidapi.com": (status_code, b'{"message": "nope"}'),
        "https://vacia.example.com": (200, EMPTY_RSS),
    }
    with caplog.at_level("DEBUG"):
        result = await _scan_with(sources, responses)

    assert result["partial"] is True
    assert result["all_sources_failed"] is False
    assert len(result["errors"]) == 1
    error = result["errors"][0]
    assert (error["source_id"], error["source_name"], error["message"]) == ("js", "Fuente js", expected)
    assert JSEARCH_KEY not in json.dumps(result)
    assert JSEARCH_KEY not in caplog.text


@pytest.mark.asyncio
async def test_scan_all_sources_jsearch_postings_become_leads(jsearch_source):
    async def fake_generate_text(prompt, **kwargs):
        return json.dumps([{"id": 0, "relevance_score": 0.9, "matched_keywords": ["BPO"], "reasoning": "x"}])

    with (
        patch.object(httpx.AsyncClient, "stream", _stream_by_url({
            "https://jsearch.p.rapidapi.com": (200, _jsearch_body([_jsearch_job()])),
        })),
        patch.object(svc, "_is_duplicate", new_callable=AsyncMock, return_value=False),
        patch.object(svc.deepseek_service, "generate_text", fake_generate_text),
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock) as mock_create,
    ):
        result = await svc.scan_all_sources(fake_pipeline_config({"sources": [jsearch_source()]}), "run-1")

    assert result["leads_new"] == 1
    lead = mock_create.call_args.args[0]
    assert lead["job_url"] == "https://acme.example.com/apply/1"
    assert lead["location"] == "London, GB"
    assert lead["source_id"] == "jsearch-1"
    assert svc._run_deadline.get() is None

# ── RF14-D-001: la misma vacante dentro de una ejecución da un solo lead ─────
@pytest.mark.asyncio
async def test_scan_all_sources_dedupes_repeated_posting_within_the_same_run():
    """Mismo cargo y empresa en distinta ubicación, en la misma fuente y en otra fuente
    de la misma ejecución: la huella (empresa + cargo) deja un solo lead, el primero."""
    santiago = fake_posting(company_name="QA Duplicada SpA", job_title="Agente de contact center", location="Santiago")
    concepcion = fake_posting(company_name="QA Duplicada SpA", job_title="Agente de contact center", location="Concepción")
    otra_fuente = fake_posting(company_name="qa duplicada spa", job_title="Agente de Contact Center", location="Valparaíso", source_id="source-b")
    config = fake_pipeline_config({"sources": [fake_source({"id": "source-a"}), fake_source({"id": "source-b"})]})

    async def fake_scan_source(source, keywords):
        return [santiago, concepcion] if source["id"] == "source-a" else [otra_fuente]

    async def fake_score(postings, keywords):
        return {i: {"relevance_score": 0.9, "matched_keywords": []} for i in range(len(postings))}

    with (
        patch.object(svc, "_scan_source", side_effect=fake_scan_source),
        patch.object(svc, "_is_duplicate", new_callable=AsyncMock, return_value=False),
        patch.object(svc, "score_relevance_batch", side_effect=fake_score) as mock_score,
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock) as mock_create,
    ):
        result = await svc.scan_all_sources(config, "run-1")

    assert result["leads_new"] == 1
    mock_create.assert_awaited_once()
    assert mock_create.call_args.args[0]["location"] == "Santiago"
    assert sum(len(call.args[0]) for call in mock_score.call_args_list) == 1  # el repetido no va al modelo


# ── RF14-D-002: formato declarable «Cargo - Empresa» (separa en el ÚLTIMO « - ») ──
@pytest.mark.parametrize("title,expected", [
    ("Agente de back office - QA Formato B", ("Agente de back office", "QA Formato B")),
    ("Ejecutivo - Turno noche - Acme SpA", ("Ejecutivo - Turno noche", "Acme SpA")),  # el cargo puede llevar guiones
    ("Sin separador", ("Sin separador", "")),        # no coincide con el formato: entero y sin empresa
    (" - Acme", (" - Acme".strip(), "")),             # cargo vacío: no se adivina
    ("Analista - ", ("Analista -", "")),              # empresa vacía: no se adivina
])
def test_split_rss_title_title_dash_company(title, expected):
    assert svc._split_rss_title(title, "title_dash_company") == expected
