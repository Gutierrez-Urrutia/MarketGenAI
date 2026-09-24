"""Unit tests for app.core.url_safety — SSRF protection used by
job_scout_service.py and routers/pipeline.py."""
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


# ── safe_get: redirect handling ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_safe_get_follows_and_revalidates_each_redirect_hop():
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    calls = []

    async def fake_get(self, url, headers=None, params=None, follow_redirects=None, **kwargs):
        calls.append(url)
        request = httpx.Request("GET", url)
        if url == "https://a.example.com/start":
            return httpx.Response(302, headers={"location": "https://b.example.com/next"}, request=request)
        return httpx.Response(200, text="ok", request=request)

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo),
        patch.object(httpx.AsyncClient, "get", fake_get),
    ):
        async with httpx.AsyncClient() as client:
            resp = await url_safety.safe_get(client, "https://a.example.com/start")

    assert resp.status_code == 200
    assert calls == ["https://a.example.com/start", "https://b.example.com/next"]


@pytest.mark.asyncio
async def test_safe_get_blocks_redirect_to_internal_host():
    def fake_getaddrinfo(host, port, *args, **kwargs):
        ip = "93.184.216.34" if host == "a.example.com" else "10.0.0.5"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]

    async def fake_get(self, url, headers=None, params=None, follow_redirects=None, **kwargs):
        request = httpx.Request("GET", url)
        if url == "https://a.example.com/start":
            return httpx.Response(302, headers={"location": "https://internal.example.com/x"}, request=request)
        pytest.fail("blocked redirect target must never be requested")

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo),
        patch.object(httpx.AsyncClient, "get", fake_get),
    ):
        async with httpx.AsyncClient() as client:
            with pytest.raises(url_safety.UnsafeUrlError):
                await url_safety.safe_get(client, "https://a.example.com/start")


@pytest.mark.asyncio
async def test_safe_get_caps_redirect_chain_length():
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    async def fake_get(self, url, headers=None, params=None, follow_redirects=None, **kwargs):
        request = httpx.Request("GET", url)
        n = int(url.rsplit("/", 1)[-1])
        return httpx.Response(302, headers={"location": f"https://a.example.com/{n + 1}"}, request=request)

    with (
        patch.object(url_safety.socket, "getaddrinfo", side_effect=fake_getaddrinfo),
        patch.object(httpx.AsyncClient, "get", fake_get),
    ):
        async with httpx.AsyncClient() as client:
            with pytest.raises(url_safety.UnsafeUrlError, match="Too many redirects"):
                await url_safety.safe_get(client, "https://a.example.com/0")


@pytest.mark.asyncio
async def test_safe_get_never_delegates_redirects_to_httpx():
    """Every real GET the underlying httpx client makes must be called with
    follow_redirects=False -- redirect-following is safe_get's own job, so
    a redirect can never bypass validate_url_target."""
    with patch.object(url_safety.socket, "getaddrinfo", side_effect=_fake_getaddrinfo("93.184.216.34")):
        async with httpx.AsyncClient() as client:
            with patch.object(client, "get", new_callable=AsyncMock) as mock_get:
                mock_get.return_value = httpx.Response(
                    200, text="ok", request=httpx.Request("GET", "https://example.com"),
                )
                await url_safety.safe_get(client, "https://example.com")

    assert mock_get.call_args.kwargs["follow_redirects"] is False
