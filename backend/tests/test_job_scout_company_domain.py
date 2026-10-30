"""T9a (part 2): the company domain travels from an RSS entry's summary to
the saved lead. RF15: a JSearch offer's employer_website and job_id too.
Company names and URLs are invented."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.core.pipeline_constants import POSTING_DESCRIPTION_MAX_CHARS
from app.schemas.lead import Lead, RawJobPosting
from app.services import job_scout_service as svc
from tests.test_job_scout_service import (  # noqa: F401 — fixtures (autouse DNS, jsearch_source) are activated by importing them
    _fake_dns_resolves_to_public_ip,
    _FakeStreamCtx,
    _jsearch_body,
    _jsearch_job,
    _scan_jsearch_with,
    _scan_rss_with_entries,
    _stream_response,
    fake_pipeline_config,
    fake_posting,
    fake_source,
    jsearch_source,
)
from tests.test_leads_router import fake_lead, firestore_lead

RSS_SOURCE = fake_source({"source_type": "rss", "config": {"feed_url": "https://feeds.example.com/jobs.rss"}})


def rss_entry(summary: str, title: str = "Senior Backend Developer", link: str = "https://jobs.example.com/1"):
    entry = MagicMock()
    entry.title = title
    entry.summary = summary
    entry.link = link
    return entry


def header(url_line: str = "", location: str = "Minnesota") -> str:
    return f"<p>\n  <strong>Headquarters:</strong> {location}\n  {url_line}\n</p>\n<h3>About the role</h3><p>Body.</p>"


def url_line(href: str) -> str:
    return f'<br /><strong>URL:</strong> <a href="{href}">{href}</a>'


# ── _scan_rss ─────────────────────────────────────────────────────────────────
async def test_rss_entry_with_url_line_gets_normalized_domain_and_source():
    postings = await _scan_rss_with_entries(RSS_SOURCE, [rss_entry(header(url_line("https://careers.nortevial.com/jobs/")))])
    assert len(postings) == 1
    assert postings[0].company_domain == "nortevial.com"
    assert postings[0].company_domain_source == "rss_url_line"


async def test_domain_comes_from_the_full_summary_not_the_600_char_cut():
    # The URL line ends past POSTING_DESCRIPTION_MAX_CHARS: only the full
    # summary has it. The stored description is still cut as before.
    summary = header(url_line("https://www.nortevial.com/"), location="Remote " + "x" * 700)
    assert summary.index("nortevial") > POSTING_DESCRIPTION_MAX_CHARS

    postings = await _scan_rss_with_entries(RSS_SOURCE, [rss_entry(summary)])

    assert postings[0].company_domain == "nortevial.com"
    assert postings[0].job_description == summary[:POSTING_DESCRIPTION_MAX_CHARS]
    assert "nortevial" not in postings[0].job_description


async def test_rss_entry_without_url_line_has_no_domain():
    postings = await _scan_rss_with_entries(RSS_SOURCE, [rss_entry(header())])
    assert len(postings) == 1
    assert postings[0].company_domain is None
    assert postings[0].company_domain_source is None


async def test_url_line_pointing_to_a_job_board_has_no_domain_nor_source():
    postings = await _scan_rss_with_entries(RSS_SOURCE, [rss_entry(header(url_line("https://jobs.lever.co/nortevial")))])
    assert postings[0].company_domain is None
    assert postings[0].company_domain_source is None


async def test_extraction_error_never_rejects_the_entry():
    entries = [rss_entry(header(url_line("https://www.nortevial.com/"))), rss_entry(header(), link="https://jobs.example.com/2")]
    with patch.object(svc.company_domain_service, "company_domain_from_description", side_effect=RuntimeError("boom")):
        postings = await _scan_rss_with_entries(RSS_SOURCE, entries)

    assert len(postings) == 2  # both entries survive
    assert all(p.company_domain is None and p.company_domain_source is None for p in postings)
    assert postings[0].job_title == "Senior Backend Developer"


async def test_entry_with_empty_summary_has_no_domain():
    postings = await _scan_rss_with_entries(RSS_SOURCE, [rss_entry("")])
    assert postings[0].company_domain is None


async def test_rss_entry_has_no_source_job_id():
    postings = await _scan_rss_with_entries(RSS_SOURCE, [rss_entry(header(url_line("https://www.nortevial.com/")))])
    assert postings[0].company_domain_source == "rss_url_line"
    assert postings[0].source_job_id is None


# ── _scan_jsearch ─────────────────────────────────────────────────────────────
async def _scan_one_jsearch_job(source: dict, **overrides):
    postings, _, problems = await _scan_jsearch_with(source, [(200, _jsearch_body([_jsearch_job(**overrides)]))])
    assert problems == []
    assert len(postings) == 1  # the offer is never rejected because of these fields
    return postings[0]


@pytest.mark.parametrize("website, expected", [
    ("https://www.nortevial.com", "nortevial.com"),
    ("http://www.nortevial.com/", "nortevial.com"),
    ("nortevial.com", "nortevial.com"),
    ("www.nortevial.com", "nortevial.com"),
    ("https://www.nortevial.com/es/empresa?ref=jsearch", "nortevial.com"),
    ("https://careers.acme.co.uk", "acme.co.uk"),
])
async def test_jsearch_employer_website_gets_normalized_domain_and_source(jsearch_source, website, expected):
    posting = await _scan_one_jsearch_job(jsearch_source(), employer_website=website)
    assert posting.company_domain == expected
    assert posting.company_domain_source == "jsearch_employer_website"


@pytest.mark.parametrize("website", [
    "",
    "   ",
    None,
    "https://www.linkedin.com/company/nortevial",
    "https://nortevial.github.io",
    "javascript:alert(1)",
    "not a url",
    "http://10.0.0.1",
    12345,
])
async def test_jsearch_unusable_employer_website_has_no_domain_nor_source(jsearch_source, website):
    posting = await _scan_one_jsearch_job(jsearch_source(), employer_website=website)
    assert posting.company_domain is None
    assert posting.company_domain_source is None


async def test_jsearch_offer_without_employer_website_has_no_domain_nor_source(jsearch_source):
    job = _jsearch_job()
    assert "employer_website" not in job
    posting = await _scan_one_jsearch_job(jsearch_source())
    assert posting.company_domain is None
    assert posting.company_domain_source is None


@pytest.mark.parametrize("overrides, expected", [
    ({"job_id": "aBc123XyZ=="}, "aBc123XyZ=="),
    ({"job_id": "  aBc123XyZ==  "}, "aBc123XyZ=="),
    ({}, None),
    ({"job_id": ""}, None),
    ({"job_id": "   "}, None),
    ({"job_id": None}, None),
])
async def test_jsearch_source_job_id(jsearch_source, overrides, expected):
    posting = await _scan_one_jsearch_job(jsearch_source(), **overrides)
    assert posting.source_job_id == expected


async def test_jsearch_keeps_the_other_fields_as_before(jsearch_source):
    posting = await _scan_one_jsearch_job(
        jsearch_source(), employer_website="https://www.nortevial.com", job_id="id-1",
    )
    assert posting.job_title == "Customer Support Agent"
    assert posting.company_name == "Acme Ltd"
    assert posting.job_description == "Handle inbound customer tickets."
    assert posting.job_url == "https://acme.example.com/apply/1"
    assert posting.location == "London, GB"
    assert posting.source_id == "jsearch-1"
    assert posting.raw_title is None


async def test_api_source_ignores_employer_website_and_job_id():
    source = fake_source()

    def fake_stream(self, method, url, headers=None, params=None, **kwargs):
        body = json.dumps({"data": [{
            "title": "Ops Manager", "company": "Acme", "url": "https://acme.example.com/1",
            "employer_website": "https://www.nortevial.com", "job_id": "id-1",
        }]}).encode()
        return _FakeStreamCtx(_stream_response(200, content=body, url=url))

    with patch.object(httpx.AsyncClient, "stream", fake_stream):
        postings = await svc._scan_api(source, [])

    assert len(postings) == 1
    assert postings[0].company_domain is None
    assert postings[0].company_domain_source is None
    assert postings[0].source_job_id is None


# ── Schemas ───────────────────────────────────────────────────────────────────
def test_raw_job_posting_domain_fields_default_to_none():
    posting = fake_posting()
    assert posting.company_domain is None
    assert posting.company_domain_source is None
    assert posting.source_job_id is None


def test_lead_saved_before_rf15_reads_without_source_job_id():
    doc = firestore_lead()
    assert "source_job_id" not in doc
    assert Lead.model_validate(doc).source_job_id is None


def test_lead_reads_source_job_id():
    lead = Lead.model_validate(fake_lead({"source_job_id": "id-1"}))
    assert lead.source_job_id == "id-1"
    assert lead.model_dump(mode="json")["source_job_id"] == "id-1"


def test_lead_saved_before_t9a_reads_without_the_new_fields():
    doc = firestore_lead()
    assert "company_domain" not in doc and "company_domain_source" not in doc
    lead = Lead.model_validate(doc)
    assert lead.company_domain is None
    assert lead.company_domain_source is None


def test_lead_reads_the_new_fields():
    lead = Lead.model_validate(fake_lead({"company_domain": "nortevial.com", "company_domain_source": "rss_url_line"}))
    assert lead.company_domain == "nortevial.com"
    assert lead.company_domain_source == "rss_url_line"
    assert lead.model_dump(mode="json")["company_domain"] == "nortevial.com"


# ── scan_all_sources: the fields reach the saved document ─────────────────────
async def _persist(posting: RawJobPosting) -> dict:
    async def fake_generate_text(prompt, **kwargs):
        return json.dumps([{"id": 0, "relevance_score": 0.9, "matched_keywords": ["BPO"], "reasoning": "x"}])

    with (
        patch.object(svc, "_scan_source", new_callable=AsyncMock, return_value=[posting]),
        patch.object(svc, "_is_duplicate", new_callable=AsyncMock, return_value=False),
        patch.object(svc.deepseek_service, "generate_text", fake_generate_text),
        patch.object(svc.leads_repo, "create", new_callable=AsyncMock) as mock_create,
    ):
        await svc.scan_all_sources(fake_pipeline_config(), "run-1")
    mock_create.assert_awaited_once()
    return mock_create.call_args.args[0]


async def test_saved_lead_document_carries_the_domain_and_source():
    persisted = await _persist(fake_posting(company_domain="nortevial.com", company_domain_source="rss_url_line"))
    assert persisted["company_domain"] == "nortevial.com"
    assert persisted["company_domain_source"] == "rss_url_line"


async def test_saved_lead_document_has_none_when_there_is_no_domain():
    persisted = await _persist(fake_posting())
    assert persisted["company_domain"] is None
    assert persisted["company_domain_source"] is None


async def test_fingerprint_does_not_depend_on_the_domain():
    with_domain = await _persist(fake_posting(company_domain="nortevial.com", company_domain_source="rss_url_line"))
    without = await _persist(fake_posting())
    assert with_domain["fingerprint"] == without["fingerprint"]


async def test_saved_lead_document_carries_the_jsearch_domain_and_source_job_id():
    persisted = await _persist(fake_posting(
        company_domain="nortevial.com", company_domain_source="jsearch_employer_website", source_job_id="id-1",
    ))
    assert persisted["company_domain"] == "nortevial.com"
    assert persisted["company_domain_source"] == "jsearch_employer_website"
    assert persisted["source_job_id"] == "id-1"


async def test_saved_lead_document_has_none_when_there_is_no_source_job_id():
    persisted = await _persist(fake_posting())
    assert persisted["source_job_id"] is None


async def test_fingerprint_does_not_depend_on_the_source_job_id():
    with_id = await _persist(fake_posting(source_job_id="id-1"))
    other_id = await _persist(fake_posting(source_job_id="id-2"))
    without = await _persist(fake_posting())
    assert with_id["fingerprint"] == other_id["fingerprint"] == without["fingerprint"]
