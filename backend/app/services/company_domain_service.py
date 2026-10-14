"""Company domain of a lead, from its job posting (T9a: extraction and
normalization). Pure functions: no network, no I/O.

weworkremotely.com postings carry a header block at the top of the
description:

    <p>
      <strong>Headquarters:</strong> Minnesota
      <br /><strong>URL:</strong> <a href="https://www.example.com/">…</a>
    </p>

extract_company_url() reads that "URL:" line — only inside the header block
that holds "Headquarters:", never a "URL:" further down the body — and
normalize_domain() reduces it to the company's registrable domain
("https://careers.example.co.uk/jobs" → "example.co.uk").

Postings without that line get no domain: nothing is guessed from other
links, email addresses or the company name.

Platform pages are not a company domain. The Public Suffix List (bundled
with publicsuffixlist, read from the package — never downloaded) has a
private section for platforms that host other people's sites (github.io,
notion.site, vercel.app, myshopify.com...): a host under one of those is
rejected. Platforms outside that section (job boards, ATSs, link-in-bio and
link shorteners, social networks) are rejected through NON_COMPANY_DOMAINS.
An employer whose own domain is one of those roots (GitHub hiring with
github.com, Google with google.com, Medium with medium.com...) is therefore
left without a domain: that is the safe side of the error — no domain is
better than attributing a platform's domain to the wrong company.

Only the first HEADER_SCAN_MAX_CHARS characters of a description are
parsed: the header block sits at the very top, and a huge description must
not cost a full HTML parse.

Neither function ever raises: any error returns None.
"""
from __future__ import annotations

import ipaddress
import re
import unicodedata
from functools import lru_cache
from typing import Any, Optional
from urllib.parse import urlparse

import idna
from bs4 import BeautifulSoup
from publicsuffixlist import PublicSuffixList

# Registrable roots that never identify a hiring company. Compared against
# the ICANN registrable domain, so "jobs.lever.co" and "x.github.io" match
# "lever.co" and "github.io".
NON_COMPANY_DOMAINS = frozenset({
    # Job boards and ATSs (a posting's link, not the company's site)
    "weworkremotely.com", "linkedin.com", "lnkd.in", "indeed.com", "glassdoor.com",
    "wellfound.com", "angel.co", "lever.co", "greenhouse.io", "ashbyhq.com",
    "workable.com", "bamboohr.com", "smartrecruiters.com", "recruitee.com",
    "breezy.hr", "jobvite.com", "myworkdayjobs.com", "teamtailor.com", "personio.de",
    # Platforms that host other people's sites (also in the PSL private section)
    "github.io", "notion.site", "vercel.app", "netlify.app", "herokuapp.com",
    "wixsite.com", "webflow.io", "carrd.co", "myshopify.com", "blogspot.com",
    # Link-in-bio pages and link shorteners
    "linktr.ee", "beacons.ai", "bio.link", "bit.ly", "t.co", "tinyurl.com", "goo.gl", "forms.gle",
    # Social networks, code hosting, generic content sites
    "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com",
    "tiktok.com", "medium.com", "substack.com", "github.com", "gitlab.com",
    "google.com",
})

MAX_URL_LENGTH = 2048

# The "Headquarters:" / "URL:" header block is at the top of the description
# (the "URL:" label was always within the first ~250 characters in the
# weworkremotely.com feed); nothing beyond this many characters is parsed.
HEADER_SCAN_MAX_CHARS = 5000

# A scheme without dots ("javascript:", "mailto:", "data:", "tel:"). A bare
# host with a port ("www.example.com:8080") has dots before the colon and is
# not mistaken for one.
_SCHEME_RE = re.compile(r"^([a-z][a-z0-9+-]*):", re.IGNORECASE)
_URL_LABEL_RE = re.compile(r"^\s*url\s*:?\s*$", re.IGNORECASE)
_HEADQUARTERS_LABEL_RE = re.compile(r"^\s*headquarters\s*:?\s*$", re.IGNORECASE)


@lru_cache(maxsize=1)
def _psl_full() -> PublicSuffixList:
    # accept_unknown=False: a made-up TLD ("acme.zzz") has no registrable domain.
    return PublicSuffixList(accept_unknown=False)


@lru_cache(maxsize=1)
def _psl_icann() -> PublicSuffixList:
    return PublicSuffixList(accept_unknown=False, only_icann=True)


def _has_control_chars(value: str) -> bool:
    return any(unicodedata.category(ch) in ("Cc", "Zl", "Zp") for ch in value)


# ── Normalization ─────────────────────────────────────────────────────────────
def _normalize_domain(url: Any) -> Optional[str]:
    if not isinstance(url, str) or _has_control_chars(url):
        return None
    candidate = url.strip()
    if not candidate or len(candidate) > MAX_URL_LENGTH:
        return None

    scheme = _SCHEME_RE.match(candidate)
    if scheme and scheme.group(1).lower() not in ("http", "https"):
        return None  # javascript:, mailto:, data:, ftp:... — never a company site
    if "://" not in candidate:
        candidate = f"http://{candidate}"  # "www.example.com/about"

    parsed = urlparse(candidate)
    if parsed.scheme.lower() not in ("http", "https"):
        return None
    host = (parsed.hostname or "").rstrip(".")
    if not host:
        return None
    try:
        ipaddress.ip_address(host)
        return None  # an IP address is not a company domain
    except ValueError:
        pass

    ascii_host = idna.encode(host, uts46=True).decode("ascii")
    if "." not in ascii_host:
        return None  # "localhost", "intranet"

    registrable = _psl_full().privatesuffix(ascii_host)
    icann_registrable = _psl_icann().privatesuffix(ascii_host)
    if not registrable or not icann_registrable:
        return None  # a public suffix itself ("co.uk", "github.io") or an unknown TLD
    if registrable != icann_registrable:
        return None  # hosted under a private-section suffix: a platform page, not a company domain
    if icann_registrable in NON_COMPANY_DOMAINS:
        return None
    return registrable


def normalize_domain(url: Any) -> Optional[str]:
    """Registrable domain of `url` ("https://careers.example.co.uk/x" →
    "example.co.uk"), lowercased and IDNA-encoded; None if it is not a usable
    company domain (non-http scheme, IP, single label, unknown TLD, platform
    page, job board...). Never raises."""
    try:
        return _normalize_domain(url)
    except Exception:
        return None


# ── Extraction ────────────────────────────────────────────────────────────────
def _label_text(tag: Any) -> str:
    return tag.get_text(" ", strip=True) if tag is not None else ""


_BLOCK_TAGS = frozenset({"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "section"})


def _url_after_label(label: Any) -> Optional[str]:
    """The URL that follows a <strong>URL:</strong> label in the same line:
    an <a>'s href (or its text, without href), else the first word of the
    plain text after it. Stops at the next <br> or label."""
    for sibling in label.next_siblings:
        name = getattr(sibling, "name", None)
        if name is None:  # a text node
            text = str(sibling).strip()
            if text:
                word = text.split()[0]
                # A tag cut off by HEADER_SCAN_MAX_CHARS reaches the parser as text ("<a href=...").
                return None if word.startswith("<") else word
            continue
        if name == "a":
            href = (sibling.get("href") or "").strip()
            return href or _label_text(sibling) or None
        if name in ("br", "strong", "b") or name in _BLOCK_TAGS:
            return None
    return None


def _extract_company_url(description_html: Any) -> Optional[str]:
    if not isinstance(description_html, str) or not description_html.strip():
        return None
    # The header is at the top: never parse more than HEADER_SCAN_MAX_CHARS.
    soup = BeautifulSoup(description_html[:HEADER_SCAN_MAX_CHARS], "html.parser")
    for headquarters in soup.find_all(["strong", "b"]):
        if not _HEADQUARTERS_LABEL_RE.match(_label_text(headquarters)):
            continue
        # The header block is what follows "Headquarters:" up to the next
        # block element; a "URL:" further down the body is never used.
        for sibling in headquarters.next_siblings:
            name = getattr(sibling, "name", None)
            if name in _BLOCK_TAGS:
                break
            if name in ("strong", "b") and _URL_LABEL_RE.match(_label_text(sibling)):
                return _url_after_label(sibling)
        return None  # header block without a "URL:" line
    return None  # no "Headquarters:" header: nothing is used


def extract_company_url(description_html: Any) -> Optional[str]:
    """Raw URL from the "URL:" line of the posting's header block (the one
    with "Headquarters:"), or None. Not normalized. Never raises."""
    try:
        return _extract_company_url(description_html)
    except Exception:
        return None


def company_domain_from_description(description_html: Any) -> Optional[str]:
    """extract_company_url + normalize_domain. Never raises."""
    return normalize_domain(extract_company_url(description_html))
