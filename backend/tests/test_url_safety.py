"""Unit tests for app.core.url_safety — SSRF protection and response-size
capping used by job_scout_service.py and routers/pipeline.py."""
from __future__ import annotations

import socket
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.core import url_safety


def _fake_getaddrinfo(ip: str):
    def _impl(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]
    return _impl


class _FakeStreamCtx:
    """Stand-in for what `httpx.AsyncClient.stream(...)` returns: an async
    context manager yielding a response. `safe_get_bytes` reads the body via
    `response.aiter_bytes()`, which works out of the box on a manually
    constructed `httpx.Response(..., content=...)`."""

    def __init__(self, response: httpx.Response):
        self._response = response

    async def __aenter__(self) -> httpx.Response:
        return self._response

    async def __aexit__(self, *exc_info):
        return False


def _stream_response(status_code: int, content: bytes = b"", headers: dict | None = None, url: str = "https://x/") -> httpx.Response:
    request = httpx.Request("GET", url)
    return httpx.Response(status_code, content=content, headers=headers or {}, request=request)


# ── validate_url_shape (scheme-only, no DNS) ────────────────────────────────

@pytest.mark.parametrize("scheme", ["javascript", "file", "ftp", "data", "gopher"])
def test_validate_url_shape_rejects_non_http_schemes(scheme):
    with pytest.raises(url_safety.UnsafeUrlError):
        url_safety.validate_url_shape(f"{scheme}://example.com/x")


@pytest.mark.parametrize("url", ["https://example.com", "http://example.com/path?q=1"])
def test_validate_url_shape_accepts_http_https(url):
    url_safety.validate_url_shape(url)  # must not raise


def test_validate_url_shape_rejects_missing_host():
    with pytest.raises(url_safety.UnsafeUrlError):
        url_safety.validate_url_shape("https:///no-host")


def test_validate_url_shape_rejects_empty_string():
    with pytest.raises(url_safety.UnsafeUrlError):
        url_safety.validate_url_shape("")


# ── validate_url_target (scheme + DNS + IP-range block) ─────────────────────

@pytest.mark.asyncio
async def test_validate_url_target_allows_public_ip():
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=_fake_getaddrinfo("93.184.216.34")):
        await url_safety.validate_url_target("https://example.com/x")  # must not raise


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_ip,label", [
    ("127.0.0.1", "loopback"),
    ("10.0.0.5", "private (RFC1918)"),
    ("172.16.0.1", "private (RFC1918)"),
    ("192.168.1.1", "private (RFC1918)"),
    ("169.254.169.254", "link-local / cloud metadata"),
    ("0.0.0.0", "unspecified"),
    ("224.0.0.1", "multicast"),
])
async def test_validate_url_target_blocks_internal_ips(blocked_ip, label):
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=_fake_getaddrinfo(blocked_ip)):
        with pytest.raises(url_safety.UnsafeUrlError):
            await url_safety.validate_url_target("https://internal.example.com/x")


@pytest.mark.asyncio
async def test_validate_url_target_blocks_ipv6_loopback():
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", 0, 0, 0))]
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo):
        with pytest.raises(url_safety.UnsafeUrlError):
            await url_safety.validate_url_target("https://internal.example.com/x")


@pytest.mark.asyncio
async def test_validate_url_target_raises_on_unresolvable_host():
    def fake_getaddrinfo(host, port, *args, **kwargs):
        raise socket.gaierror("name or service not known")
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo):
        with pytest.raises(url_safety.UnsafeUrlError):
            await url_safety.validate_url_target("https://does-not-exist.example.invalid/x")


@pytest.mark.asyncio
async def test_validate_url_target_rejects_bad_scheme_before_any_dns_lookup():
    with patch.object(url_safety.socket, "getaddrinfo") as mock_dns:
        with pytest.raises(url_safety.UnsafeUrlError):
            await url_safety.validate_url_target("javascript:alert(1)")
    mock_dns.assert_not_called()


# ── safe_get_bytes: redirect handling ────────────────────────────────────────

@pytest.mark.asyncio
async def test_safe_get_bytes_follows_and_revalidates_each_redirect_hop():
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    calls = []

    def fake_stream(self, method, url, headers=None, params=None, follow_redirects=None, **kwargs):
        calls.append(url)
        if url == "https://a.example.com/start":
            return _FakeStreamCtx(_stream_response(302, headers={"location": "https://b.example.com/next"}, url=url))
        return _FakeStreamCtx(_stream_response(200, content=b"ok", url=url))

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
    ):
        async with httpx.AsyncClient() as client:
            status_code, body = await url_safety.safe_get_bytes(
                client, "https://a.example.com/start", max_bytes=1024,
            )

    assert status_code == 200
    assert body == b"ok"
    assert calls == ["https://a.example.com/start", "https://b.example.com/next"]


@pytest.mark.asyncio
async def test_safe_get_bytes_blocks_redirect_to_internal_host():
    def fake_getaddrinfo(host, port, *args, **kwargs):
        ip = "93.184.216.34" if host == "a.example.com" else "10.0.0.5"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]

    def fake_stream(self, method, url, headers=None, params=None, follow_redirects=None, **kwargs):
        if url == "https://a.example.com/start":
            return _FakeStreamCtx(_stream_response(302, headers={"location": "https://internal.example.com/x"}, url=url))
        pytest.fail("blocked redirect target must never be requested")

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
    ):
        async with httpx.AsyncClient() as client:
            with pytest.raises(url_safety.UnsafeUrlError):
                await url_safety.safe_get_bytes(client, "https://a.example.com/start", max_bytes=1024)


@pytest.mark.asyncio
async def test_safe_get_bytes_caps_redirect_chain_length():
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    def fake_stream(self, method, url, headers=None, params=None, follow_redirects=None, **kwargs):
        n = int(url.rsplit("/", 1)[-1])
        return _FakeStreamCtx(_stream_response(302, headers={"location": f"https://a.example.com/{n + 1}"}, url=url))

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
    ):
        async with httpx.AsyncClient() as client:
            with pytest.raises(url_safety.UnsafeUrlError, match="Too many redirects"):
                await url_safety.safe_get_bytes(client, "https://a.example.com/0", max_bytes=1024)


@pytest.mark.asyncio
async def test_safe_get_bytes_never_delegates_redirects_to_httpx():
    """Every real request the underlying httpx client makes must be called
    with follow_redirects=False -- redirect-following is safe_get_bytes'
    own job, so a redirect can never bypass validate_url_target."""
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=_fake_getaddrinfo("93.184.216.34")):
        async with httpx.AsyncClient() as client:
            with patch.object(client, "stream") as mock_stream:
                mock_stream.return_value = _FakeStreamCtx(_stream_response(200, content=b"ok"))
                await url_safety.safe_get_bytes(client, "https://example.com", max_bytes=1024)

    assert mock_stream.call_args.kwargs["follow_redirects"] is False


# ── safe_get_bytes: response-size cap ───────────────────────────────────────

@pytest.mark.asyncio
async def test_safe_get_bytes_truncates_at_max_bytes_without_buffering_more():
    """The body must be cut off as soon as more than max_bytes have been
    read -- this asserts the actual streaming behavior (chunk-by-chunk),
    not just that the final result happens to be short."""
    chunk = b"x" * 1000
    total_chunks_available = 50  # 50,000 bytes on offer
    max_bytes = 4500
    chunks_consumed = {"n": 0}

    async def chunk_iter():
        for _ in range(total_chunks_available):
            chunks_consumed["n"] += 1
            yield chunk

    class _CountingResponse:
        status_code = 200
        headers: dict = {}

        def aiter_bytes(self):
            return chunk_iter()

    def fake_stream(self, method, url, headers=None, params=None, follow_redirects=None, **kwargs):
        return _FakeStreamCtx(_CountingResponse())

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=_fake_getaddrinfo("93.184.216.34")),
        patch.object(httpx.AsyncClient, "stream", fake_stream),
    ):
        async with httpx.AsyncClient() as client:
            status_code, body = await url_safety.safe_get_bytes(
                client, "https://example.com/big", max_bytes=max_bytes,
            )

    assert status_code == 200
    assert len(body) == max_bytes  # truncated, not the full 50,000 bytes
    # Reading stopped right after crossing the cap, not after consuming
    # every available chunk -- proves this is a streaming cutoff, not
    # "download everything, then slice".
    assert chunks_consumed["n"] < total_chunks_available


@pytest.mark.asyncio
async def test_safe_get_bytes_returns_full_body_under_the_cap():
    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=_fake_getaddrinfo("93.184.216.34")),
        patch.object(httpx.AsyncClient, "stream", lambda self, method, url, **kw: _FakeStreamCtx(
            _stream_response(200, content=b"small body", url=url)
        )),
    ):
        async with httpx.AsyncClient() as client:
            status_code, body = await url_safety.safe_get_bytes(
                client, "https://example.com/small", max_bytes=1_000_000,
            )

    assert status_code == 200
    assert body == b"small body"
