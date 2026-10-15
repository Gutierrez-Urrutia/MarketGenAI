"""Tests for company_domain_service (Fase 3 — T9a). Company names, URLs and
addresses below are invented, shaped like real weworkremotely.com postings."""
from __future__ import annotations

import socket
from unittest.mock import patch

import pytest

from app.services import company_domain_service as svc
from app.services.company_domain_service import (
    HEADER_SCAN_MAX_CHARS,
    NON_COMPANY_DOMAINS,
    company_domain_from_description,
    extract_company_url,
    normalize_domain,
)


def posting(header_url_line: str = "", body: str = "") -> str:
    """A description with the real header shape: Headquarters, then an
    optional URL line after a <br />, then the body."""
    return (
        "<p>\n"
        "  <strong>Headquarters:</strong> Minnesota\n"
        f"  {header_url_line}\n"
        "</p>\n"
        f"{body}"
    )


def url_line(href: str, text: str | None = None) -> str:
    return f'<br /><strong>URL:</strong> <a href="{href}">{text if text is not None else href}</a>'


# ── normalize_domain: company domains ─────────────────────────────────────────
@pytest.mark.parametrize("url, expected", [
    ("https://www.nortevial.com/careers/", "nortevial.com"),           # with a path
    ("https://careers.lumenaro.io/", "lumenaro.io"),                    # careers subdomain
    ("https://jobs.brisacode.co.uk/openings", "brisacode.co.uk"),       # two-level public suffix
    ("https://nortevial.com", "nortevial.com"),
    ("http://WWW.Tallerbit.COM./", "tallerbit.com"),                    # http, uppercase, trailing dot
    ("https://www.tallerbit.com:8443/about", "tallerbit.com"),          # port
    ("www.tallerbit.com", "tallerbit.com"),                             # no scheme
    ("tallerbit.com/about-us", "tallerbit.com"),
    ("  https://www.tallerbit.com/  ", "tallerbit.com"),
    ("https://www.bücherwald.de/", "xn--bcherwald-q9a.de"),            # IDN → punycode
    ("https://www.xn--bcherwald-q9a.de/", "xn--bcherwald-q9a.de"),
    ("https://user@www.tallerbit.com/", "tallerbit.com"),               # userinfo: the host is what counts
    ("https://www.tallerbit.com/?a=1&b=2#team", "tallerbit.com"),
])
def test_normalize_domain_returns_the_registrable_domain(url, expected):
    assert normalize_domain(url) == expected


# ── normalize_domain: platforms (PSL private section) and NON_COMPANY_DOMAINS ─
@pytest.mark.parametrize("url", [
    # Pages hosted under a private-section suffix: not a company domain
    "https://qorvanta.github.io/",
    "https://qorvanta.notion.site/Careers-123",
    "https://qorvanta.vercel.app",
    "https://qorvanta.wixsite.com/home",
    "https://qorvanta.myshopify.com",
    "https://qorvanta.blogspot.com",
    "https://qorvanta.webflow.io",
    # The platform roots themselves
    "https://github.io", "https://notion.site", "https://vercel.app", "https://wixsite.com",
    "https://linktr.ee/qorvanta",
    # Job boards and ATSs
    "https://jobs.lever.co/qorvanta/abc-123",
    "https://boards.greenhouse.io/qorvanta",
    "https://weworkremotely.com/remote-jobs/qorvanta-backend-dev",
    "https://www.linkedin.com/company/qorvanta",
    # Shorteners, social, code hosting
    "https://bit.ly/3xYz", "https://www.facebook.com/qorvanta", "https://github.com/qorvanta",
    "https://sites.google.com/view/qorvanta",
])
def test_normalize_domain_rejects_platform_and_job_board_urls(url):
    assert normalize_domain(url) is None


@pytest.mark.parametrize("root", ["notion.site", "github.io", "vercel.app", "linktr.ee", "wixsite.com"])
def test_required_platform_roots_are_blocked(root):
    assert root in NON_COMPANY_DOMAINS


def test_every_blocked_entry_is_a_registrable_root():
    # Matching happens against the ICANN registrable domain, so an entry like
    # "jobs.lever.co" would never match anything.
    for entry in NON_COMPANY_DOMAINS:
        assert entry == entry.lower().strip()
        assert svc._psl_icann().privatesuffix(entry) == entry, entry


@pytest.mark.parametrize("url", [
    "https://qorvanta.pages.dev",
    "https://qorvanta.azurewebsites.net",
    "https://qorvanta.firebaseapp.com",
    "https://qorvanta.onrender.com",
])
def test_private_section_platforms_are_rejected_even_if_not_listed(url):
    # These roots are NOT in NON_COMPANY_DOMAINS: the PSL private section
    # alone has to reject them.
    host = url.split("//")[1]
    assert svc._psl_icann().privatesuffix(host) not in NON_COMPANY_DOMAINS
    assert normalize_domain(url) is None


def test_private_suffix_is_detected_not_mistaken_for_its_icann_root():
    # With only the ICANN list, every GitHub Pages site would look like the
    # company "github.io"; the full list tells the platform apart.
    assert svc._psl_icann().privatesuffix("qorvanta.github.io") == "github.io"
    assert svc._psl_full().privatesuffix("qorvanta.github.io") == "qorvanta.github.io"
    assert normalize_domain("https://qorvanta.github.io") is None


# ── normalize_domain: unusable input → None, never an exception ──────────────
@pytest.mark.parametrize("value", [
    None, 123, 4.5, b"https://nortevial.com", ["https://nortevial.com"],
    "", "   ",
    "http://[abc",                                    # malformed: urlparse raises ValueError
    "https://[::1",
    "javascript:alert(1)",
    "JavaScript:alert(document.domain)",
    "mailto:talento@qorvantagroup.com",               # never take a domain from an address
    "data:text/html,<b>x</b>",
    "ftp://files.nortevial.com/",
    "tel:+56912345678",
    "http://10.0.0.5/",
    "http://[2001:db8::1]/",
    "http://localhost:8000",
    "http://intranet/",
    "https://nortevial.zzzunknown",                   # unknown TLD
    "https://co.uk",                                  # a public suffix itself
    "https://com",
    "http://",
    "https://nortevial.com\n",                        # control characters anywhere
    "https://norte\tvial.com",
    "https://" + "a" * 2050 + ".com",                 # too long
    "https://-bad-.com",                              # IDNA rejects it
])
def test_normalize_domain_returns_none_for_unusable_input(value):
    assert normalize_domain(value) is None


def test_normalize_domain_never_raises_on_an_internal_error():
    with patch.object(svc, "_psl_full", side_effect=RuntimeError("boom")):
        assert normalize_domain("https://nortevial.com") is None


# ── The suffix list works without network access ──────────────────────────────
def test_suffix_list_is_bundled_and_needs_no_network():
    def no_network(*args, **kwargs):
        raise AssertionError("network access attempted")

    svc._psl_full.cache_clear()
    svc._psl_icann.cache_clear()
    try:
        with (
            patch.object(socket, "getaddrinfo", side_effect=no_network),
            patch.object(socket, "create_connection", side_effect=no_network),
            patch.object(socket.socket, "connect", side_effect=no_network),
        ):
            # Builds both lists from the package data and uses them.
            assert normalize_domain("https://careers.lumenaro.io") == "lumenaro.io"
            assert normalize_domain("https://jobs.brisacode.co.uk") == "brisacode.co.uk"
            assert normalize_domain("https://qorvanta.github.io") is None
    finally:
        svc._psl_full.cache_clear()
        svc._psl_icann.cache_clear()


# ── extract_company_url ───────────────────────────────────────────────────────
def test_extracts_the_href_of_the_url_line_with_a_path():
    html = posting(url_line("https://www.nortevial.com/careers/"), "<h3>About Nortevial</h3>")
    assert extract_company_url(html) == "https://www.nortevial.com/careers/"
    assert company_domain_from_description(html) == "nortevial.com"


def test_extracts_a_careers_subdomain():
    html = posting(url_line("https://careers.lumenaro.io/"))
    assert extract_company_url(html) == "https://careers.lumenaro.io/"
    assert company_domain_from_description(html) == "lumenaro.io"


def test_no_url_line_gives_none():
    html = posting("", "<h3>About Tallerbit</h3><p>We build tools.</p>")
    assert extract_company_url(html) is None
    assert company_domain_from_description(html) is None


def test_url_line_wins_over_other_corporate_links_and_the_email_domain():
    # Website domain and mail domain differ: the website is the URL line;
    # the About link and the address in the body are never used.
    html = posting(
        url_line("https://www.qorvanta-apps.com/"),
        '<h3>About <a href="https://qorvantagroup.com/">Qorvanta Group</a></h3>'
        "<p>Questions? Write to talento@qorvantagroup.com.</p>"
        '<p><a href="mailto:talento@qorvantagroup.com">Apply</a></p>',
    )
    assert extract_company_url(html) == "https://www.qorvanta-apps.com/"
    assert company_domain_from_description(html) == "qorvanta-apps.com"


def test_without_url_line_other_links_and_addresses_are_not_used():
    html = posting(
        "",
        '<h3>About <a href="https://qorvantagroup.com/">Qorvanta Group</a></h3>'
        "<p>Write to talento@qorvantagroup.com.</p>",
    )
    assert company_domain_from_description(html) is None


def test_plain_text_url_without_a_link():
    html = posting("<br /><strong>URL:</strong> www.tallerbit.com")
    assert extract_company_url(html) == "www.tallerbit.com"
    assert company_domain_from_description(html) == "tallerbit.com"


def test_link_without_href_uses_its_text():
    html = posting("<br /><strong>URL:</strong> <a>https://www.tallerbit.com</a>")
    assert extract_company_url(html) == "https://www.tallerbit.com"


def test_html_entities_in_the_href_are_unescaped():
    html = posting(url_line("https://www.tallerbit.com/?ref=wwr&amp;lang=es"))
    assert extract_company_url(html) == "https://www.tallerbit.com/?ref=wwr&lang=es"


def test_label_variants_are_accepted():
    html = posting('<br /><b> url </b> <a href="https://lumenaro.io">lumenaro.io</a>')
    assert company_domain_from_description(html) == "lumenaro.io"


def test_a_url_label_in_the_body_is_ignored():
    html = posting("", '<p><strong>URL:</strong> <a href="https://www.otra-empresa.com">x</a></p>')
    assert extract_company_url(html) is None


def test_no_headquarters_header_means_no_url():
    html = '<p><strong>URL:</strong> <a href="https://www.nortevial.com">x</a></p>'
    assert extract_company_url(html) is None


def test_headquarters_outside_a_paragraph_still_stops_at_the_next_block():
    html = (
        "<strong>Headquarters:</strong> Remote"
        '<h3>About</h3><p><strong>URL:</strong> <a href="https://www.otra-empresa.com">x</a></p>'
    )
    assert extract_company_url(html) is None


def test_url_line_pointing_to_a_job_board_gives_no_domain():
    html = posting(url_line("https://jobs.lever.co/qorvanta"))
    assert extract_company_url(html) == "https://jobs.lever.co/qorvanta"
    assert company_domain_from_description(html) is None


def test_url_line_with_a_dangerous_href_gives_no_domain():
    html = posting(url_line("javascript:alert(1)", "https://www.nortevial.com"))
    assert company_domain_from_description(html) is None


def test_real_shape_with_about_section():
    html = (
        "<p>\n  <strong>Headquarters:</strong> Americas Remote\n"
        '  <br /><strong>URL:</strong> <a href="http://lumenaro.io/">http://lumenaro.io/</a>\n</p>\n\n'
        '<h3>About <a href="http://lumenaro.io/">Lumenaro</a></h3>\n<h3>About the role</h3>\n'
        "<p>We are hiring a backend developer.</p>"
    )
    assert company_domain_from_description(html) == "lumenaro.io"


@pytest.mark.parametrize("value", [
    None, 42, b"<p>x</p>", ["<p>"], "", "   ",
    "<p><strong>Headquarters:</strong> Remote <br /><strong>URL:</strong> <a href=\"https://www.nort",  # cut mid-tag
    "<<<>>>",
    "<p><strong>Headquarters:</strong>",
])
def test_extract_never_raises(value):
    extract_company_url(value)  # any result, but no exception
    company_domain_from_description(value)


def test_extract_returns_none_on_an_internal_error():
    with patch.object(svc, "BeautifulSoup", side_effect=RuntimeError("boom")):
        assert extract_company_url(posting(url_line("https://nortevial.com"))) is None


# ── HEADER_SCAN_MAX_CHARS ─────────────────────────────────────────────────────
def padded(header: str, pad_chars: int) -> str:
    """`header` preceded by a filler paragraph so that it starts at exactly
    `pad_chars` characters into the description."""
    filler = "<p>" + "x" * (pad_chars - len("<p></p>")) + "</p>"
    assert len(filler) == pad_chars
    return filler + header + "<p>About the role.</p>"


def test_scan_limit_value():
    assert HEADER_SCAN_MAX_CHARS == 5000


def test_url_line_within_the_scan_limit_is_found():
    header = posting(url_line("https://www.nortevial.com/"))
    html = padded(header, HEADER_SCAN_MAX_CHARS - len(header) - 10)  # header ends just before the limit
    assert html.index("</a>") < HEADER_SCAN_MAX_CHARS
    assert company_domain_from_description(html) == "nortevial.com"


def test_header_block_starting_beyond_the_scan_limit_is_ignored():
    html = padded(posting(url_line("https://www.nortevial.com/")), HEADER_SCAN_MAX_CHARS + 100)
    assert html.index("Headquarters:") > HEADER_SCAN_MAX_CHARS
    assert extract_company_url(html) is None
    assert company_domain_from_description(html) is None


def test_html_cut_at_the_scan_limit_does_not_raise_or_give_a_wrong_domain():
    # The limit falls right after ".co" of "nortevial.com": a cut href must
    # never turn into "nortevial.co".
    header = posting(url_line("https://www.nortevial.com/"))
    cut_inside_href = header.index("nortevial.co") + len("nortevial.co")
    html = padded(header, HEADER_SCAN_MAX_CHARS - cut_inside_href)
    assert html[:HEADER_SCAN_MAX_CHARS].endswith("https://www.nortevial.co")
    assert extract_company_url(html) is None
    assert company_domain_from_description(html) is None


@pytest.mark.parametrize("cut", range(HEADER_SCAN_MAX_CHARS - 260, HEADER_SCAN_MAX_CHARS + 1, 7))
def test_any_cut_position_near_the_limit_never_raises(cut):
    header = posting(url_line("https://careers.lumenaro.io/jobs"))
    html = padded(header, cut - len(header) // 2)
    result = company_domain_from_description(html)
    assert result in (None, "lumenaro.io")


# ── Employers whose own domain is a blocked root ──────────────────────────────
@pytest.mark.parametrize("url", [
    "https://github.com/about/careers",
    "https://careers.google.com/",
    "https://medium.com/jobs-at-medium",
])
def test_employer_whose_own_domain_is_blocked_gets_no_domain(url):
    # Documented trade-off: GitHub, Google or Medium hiring for themselves are
    # left without a domain. No domain is the safe side of the error — the
    # alternative would attribute a platform's domain to other companies.
    assert company_domain_from_description(posting(url_line(url))) is None
