"""T9a (part 2): the company domain travels from an RSS entry's summary to
the saved lead. Company names and URLs are invented."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

from app.core.pipeline_constants import POSTING_DESCRIPTION_MAX_CHARS
from app.schemas.lead import Lead, RawJobPosting
from app.services import job_scout_service as svc
from tests.test_job_scout_service import (  # noqa: F401 — the autouse fixture is activated by importing it
    _fake_dns_resolves_to_public_ip,
    _scan_rss_with_entries,
    fake_pipeline_config,
    fake_posting,
    fake_source,
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


# ── Schemas ───────────────────────────────────────────────────────────────────
def test_raw_job_posting_domain_fields_default_to_none():
    posting = fake_posting()
    assert posting.company_domain is None
    assert posting.company_domain_source is None


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
