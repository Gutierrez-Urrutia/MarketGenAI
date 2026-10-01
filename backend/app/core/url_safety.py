"""Server-side SSRF protection for outbound fetches driven by user-supplied
URLs (pipeline source config: base_url/feed_url/url).

Validated at two points, by design:
  - config-save time (routers/pipeline.py `_validate_source_url`), for
    immediate feedback to the user who configured the source.
  - fetch time (job_scout_service.py, via this module), because DNS can
    change between save and fetch (TOCTOU / DNS rebinding) — the
    save-time check is a courtesy, the fetch-time check is the real
    control and must never be skipped.

Every redirect hop is re-validated the same way as the initial URL.
Redirect-following is never delegated to httpx's own `follow_redirects`,
specifically so a redirect response can never reach the network without
first passing `validate_url_target`.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Any, Dict, Optional, Union
from urllib.parse import urljoin, urlparse

import httpx

ALLOWED_SCHEMES = {"http", "https"}
MAX_REDIRECTS = 5
_REDIRECT_STATUS_CODES = (301, 302, 303, 307, 308)

IpAddress = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]


class UnsafeUrlError(ValueError):
    """Raised when a URL fails scheme/host safety validation."""


def validate_url_shape(url: str) -> None:
    """Cheap, synchronous check: scheme + presence of a host. Safe to call
    without blocking on DNS. Does NOT resolve the host, so on its own it
    cannot catch a hostname that resolves to an internal IP — that's
    `validate_url_target`, below."""
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ALLOWED_SCHEMES:
        raise UnsafeUrlError(f"URL must use http or https (got '{parsed.scheme or 'none'}').")
    if not parsed.hostname:
        raise UnsafeUrlError("URL must include a host.")


def _is_blocked_ip(ip: IpAddress) -> bool:
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


async def validate_url_target(url: str) -> None:
    """Full safety check: scheme + DNS resolution + IP-range block
    (private/loopback/link-local — which covers cloud metadata endpoints
    like 169.254.169.254 — plus multicast/reserved/unspecified).

    Call this immediately before every request that actually goes out,
    including each redirect hop. Never cache or reuse a prior result —
    the whole point is that DNS can change between calls.
    """
    validate_url_shape(url)
    host = urlparse(url).hostname

    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except socket.gaierror as exc:
        raise UnsafeUrlError(f"Could not resolve host '{host}': {exc}") from exc

    if not infos:
        raise UnsafeUrlError(f"Could not resolve host '{host}'.")

    for info in infos:
        raw_ip = info[4][0].split("%")[0]  # strip an IPv6 zone id, if present
        ip = ipaddress.ip_address(raw_ip)
        if _is_blocked_ip(ip):
            raise UnsafeUrlError(f"URL host '{host}' resolves to a blocked address ({raw_ip}).")


async def safe_get_bytes(
    client: httpx.AsyncClient,
    url: str,
    *,
    headers: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
    max_bytes: int,
) -> "tuple[int, bytes]":
    """GET a URL with SSRF protection, returning (status_code, body).

    Validates the URL — and every redirect hop, individually, right before
    it is requested. Redirects are followed here one hop at a time instead
    of via httpx's own `follow_redirects`, specifically so a malicious
    redirect target can never bypass `validate_url_target`.

    The body is read in chunks and reading stops as soon as more than
    `max_bytes` have arrived, instead of buffering the whole response and
    only checking its size afterwards — a misbehaving or malicious source
    can't use an unbounded response to exhaust the caller's memory, since
    the memory is never allocated for the part beyond the cap in the first
    place. The returned body is truncated to `max_bytes`.

    Does not raise on a 4xx/5xx status — callers decide what that means
    for them (e.g. job_scout_service's adapters treat it as "this source
    failed"; a robots.txt fetch treats a 404 as "no restrictions").
    """
    current_url = url
    current_params = params
    for _ in range(MAX_REDIRECTS + 1):
        await validate_url_target(current_url)
        async with client.stream(
            "GET", current_url, headers=headers, params=current_params, follow_redirects=False,
        ) as response:
            if response.status_code in _REDIRECT_STATUS_CODES and response.headers.get("location"):
                current_url = urljoin(current_url, response.headers["location"])
                current_params = None  # query params applied to the original request only
                continue

            chunks = bytearray()
            byte_iter = response.aiter_bytes()
            try:
                async for chunk in byte_iter:
                    chunks.extend(chunk)
                    if len(chunks) >= max_bytes:
                        break  # stop pulling further chunks once over the cap
            finally:
                # Breaking out of `async for` early does not close the
                # underlying async generator on its own -- do it explicitly
                # so a truncated read doesn't leave anything dangling.
                await byte_iter.aclose()
            return response.status_code, bytes(chunks[:max_bytes])

    raise UnsafeUrlError(f"Too many redirects (> {MAX_REDIRECTS}) fetching '{url}'.")
