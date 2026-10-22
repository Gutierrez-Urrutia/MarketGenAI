"""Agente 1 — Job Scout (plan-pipeline-3-agentes.md §3).

Scans a PipelineConfig's enabled JobSource entries, extracts job postings,
scores their relevance to NoonDalton with DeepSeek, deduplicates by
fingerprint (scoped per pipeline_config_id — the same posting can become a
separate Lead for two different pipeline configs, dedup is never global),
and persists the ones that clear RELEVANCE_SCORE_THRESHOLD as Lead
documents.

Invocation is manual only in this phase: a router endpoint and a Celery task
both call `scan_all_sources` directly, on demand. No scheduling decision
(when to run, for which configs, how often) lives here or anywhere in this
module — that is Fase 5-6, and depends on which Vercel plan the client
confirms (see analisis-worker-serverless.md).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import urllib.robotparser
from contextvars import ContextVar
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import feedparser
import httpx
from bs4 import BeautifulSoup
from pydantic import ValidationError

from app.core import url_safety
from app.core.pipeline_constants import (
    JSEARCH_API_HOST,
    JSEARCH_DEFAULT_COUNTRY,
    JSEARCH_DEFAULT_LANGUAGE,
    JSEARCH_DEFAULT_NUM_PAGES,
    JSEARCH_FETCH_TIMEOUT_SECONDS,
    JSEARCH_MAX_PAGES,
    JSEARCH_SEARCH_URL,
    MAX_RESULTS_PER_RUN,
    MAX_RESULTS_PER_SOURCE,
    MAX_SOURCE_RESPONSE_BYTES,
    POSTING_DESCRIPTION_MAX_CHARS,
    RELEVANCE_SCORE_THRESHOLD,
    RELEVANCE_SCORING_BATCH_SIZE,
    RELEVANCE_SCORING_TIMEOUT_SECONDS,
    RUN_TIME_BUDGET_SECONDS,
    SCRAPER_MIN_DELAY_SECONDS,
    SCRAPER_ROBOTS_TXT_TIMEOUT_SECONDS,
    SCRAPER_USER_AGENT,
    SOURCE_FETCH_TIMEOUT_SECONDS,
)
from app.schemas.lead import LeadStatus, RawJobPosting
from app.schemas.pipeline import (
    RSS_TITLE_FORMAT_COMPANY_COLON_TITLE,
    RSS_TITLE_FORMAT_NONE,
    RSS_TITLE_FORMAT_TITLE_DASH_COMPANY,
    SOURCE_TYPE_SECRET_CONFIG_FIELDS,
    PipelineRunStatus,
    SourceType,
)
from app.services import company_domain_service, deepseek_service, encryption_service
from app.services.firestore_service import leads_repo, now_utc, pipeline_runs_repo

logger = logging.getLogger("marketgen.pipeline.job_scout")

_SCORE_SYSTEM_PROMPT = (
    "Eres un analista de ventas B2B para NoonDalton, empresa de outsourcing/BPO. "
    "Respondes ÚNICAMENTE con un array JSON válido, sin texto adicional antes ni después."
)


# ── Problems of the source being scanned (RF13-D-003) ───────────────────────
# The adapters keep their contract (a source that fails returns []), but say
# why through this list, which scan_all_sources opens for each source and turns
# into run.errors. A fatal problem means nothing could be read from the source;
# a non-fatal one (truncated response) still keeps what was read.
_source_problems: ContextVar[Optional[List[Dict[str, Any]]]] = ContextVar("job_scout_source_problems", default=None)


# Monotonic deadline of the run being scanned (RUN_TIME_BUDGET_SECONDS from
# its start), set by scan_all_sources around each source. An adapter that
# makes several requests (JSearch pages) checks it before each extra one.
# Unset (None) outside a run, e.g. in the /sources/{id}/test probe.
_run_deadline: ContextVar[Optional[float]] = ContextVar("job_scout_run_deadline", default=None)


def _run_budget_exhausted() -> bool:
    deadline = _run_deadline.get()
    return deadline is not None and time.monotonic() >= deadline


def _report_source_problem(message: str, *, fatal: bool = True) -> None:
    problems = _source_problems.get()
    if problems is not None:
        problems.append({"message": message, "fatal": fatal})


def _fetch_failure_message(exc: Exception) -> str:
    if isinstance(exc, url_safety.UnsafeUrlError):
        return f"URL bloqueada por seguridad: {exc}"
    if isinstance(exc, json.JSONDecodeError):
        return "la respuesta no es JSON válido"
    if isinstance(exc, httpx.HTTPError):
        return f"error de red ({type(exc).__name__})"
    return str(exc) or type(exc).__name__


def _report_if_truncated(body: bytes) -> None:
    # safe_get_bytes stops reading past MAX_SOURCE_RESPONSE_BYTES and returns
    # the body cut to that size.
    if len(body) >= MAX_SOURCE_RESPONSE_BYTES:
        _report_source_problem(
            f"respuesta truncada: superó el máximo de {MAX_SOURCE_RESPONSE_BYTES} bytes", fatal=False,
        )


# ── Secrets ──────────────────────────────────────────────────────────────────
def _resolve_source_secrets(source: Dict[str, Any]) -> Dict[str, str]:
    """Decrypt a source's secret config fields for in-memory use only.
    Never persisted, never returned in any API response.

    Legacy fallback: sources created before the fix in commit 92a01c4 may
    still have a secret field sitting in plaintext `config` instead of
    `config_encrypted` (encryption only started with that commit). Detected
    here and used as-is, with a warning — a scan must not silently fail (or
    crash) just because an older source hasn't been re-saved yet. The value
    gets encrypted automatically the next time the user edits that source in
    Settings > Pipeline (routers/pipeline.py `_split_source_config`), so no
    manual data migration or re-entry is required, but the warning is the
    signal to go do that resave."""
    source_type = SourceType(source["source_type"])
    secret_fields = set(SOURCE_TYPE_SECRET_CONFIG_FIELDS.get(source_type, []))
    encrypted = source.get("config_encrypted") or {}
    plaintext_config = source.get("config") or {}

    resolved: Dict[str, str] = {}
    for field in secret_fields:
        token = encrypted.get(field)
        if token:
            try:
                resolved[field] = encryption_service.decrypt(token)
                continue
            except Exception:
                logger.warning(
                    "job_scout: failed to decrypt secret field '%s' for source %s",
                    field, source.get("id"),
                )

        legacy_value = plaintext_config.get(field)
        if legacy_value:
            logger.warning(
                "job_scout: source %s has field '%s' stored in plaintext "
                "(created before encryption was added) — using it as-is; "
                "re-save this source in Settings > Pipeline to encrypt it.",
                source.get("id"), field,
            )
            resolved[field] = str(legacy_value)

    return resolved


# ── job_url sanitization ─────────────────────────────────────────────────────
def _sanitize_job_url(raw_url: str) -> str:
    """Only allow http/https values for a posting's job_url. A posting's
    URL is untrusted external data (an API response field, an RSS <link>,
    a scraped href) — persisting it unchecked and later rendering it as an
    <a href> lets a `javascript:` (or other non-http scheme) URL execute
    when a lead reviewer clicks it. Anything else is dropped (empty
    string), not the whole posting — a bad link shouldn't discard an
    otherwise-relevant lead. LeadList.jsx re-validates before rendering
    too, in case a pre-existing record predates this check."""
    scheme = urlparse((raw_url or "").strip()).scheme.lower()
    if scheme in ("http", "https"):
        return raw_url.strip()
    return ""


# ── Fingerprint / dedup (scoped per pipeline_config_id) ────────────────────
def compute_fingerprint(company: str, job_title: str) -> str:
    normalized = f"{company.strip().lower()}|{job_title.strip().lower()}"
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


async def _is_duplicate(pipeline_config_id: str, fingerprints: List[str]) -> bool:
    """True if any of `fingerprints` already exists as a Lead of this config.

    Two different pipeline configs (two different clients) can each have
    their own Lead for the same posting — dedup only looks within this
    config's own leads, never across all configs. Several fingerprints are
    accepted so a posting also matches a Lead stored under its legacy
    fingerprint (see `_legacy_rss_fingerprint`), in a single `in` query."""
    existing = await leads_repo.list(
        filters=[
            ("pipeline_config_id", "==", pipeline_config_id),
            ("fingerprint", "in", list(dict.fromkeys(fingerprints))),
        ],
        limit=1,
    )
    return bool(existing)


# ── Source adapters ──────────────────────────────────────────────────────────
async def _scan_api(source: Dict[str, Any], keywords: List[str]) -> List[RawJobPosting]:
    config = source.get("config") or {}
    base_url = config.get("base_url")
    if not base_url:
        _report_source_problem("falta la URL de la fuente (base_url)")
        return []
    secrets = _resolve_source_secrets(source)
    headers = dict(config.get("headers") or {})
    if secrets.get("api_key"):
        headers.setdefault("Authorization", f"Bearer {secrets['api_key']}")
    params = dict(config.get("query_params") or {})
    if keywords:
        params.setdefault("query", " ".join(keywords[:5]))

    try:
        async with httpx.AsyncClient(timeout=SOURCE_FETCH_TIMEOUT_SECONDS) as client:
            status_code, body = await url_safety.safe_get_bytes(
                client, base_url, headers=headers, params=params,
                max_bytes=MAX_SOURCE_RESPONSE_BYTES,
            )
            if status_code >= 400:
                raise ValueError(f"HTTP {status_code}")
            _report_if_truncated(body)
            payload = json.loads(body)
    except Exception as exc:
        logger.warning("job_scout: API source %s failed: %s", source.get("id"), exc)
        _report_source_problem(_fetch_failure_message(exc))
        return []

    items = payload if isinstance(payload, list) else (
        payload.get("data") or payload.get("results") or payload.get("jobs") or []
    )

    postings: List[RawJobPosting] = []
    for item in items[:MAX_RESULTS_PER_SOURCE]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("job_title") or "").strip()
        company = str(item.get("company") or item.get("employer_name") or "").strip()
        if not title or not company:
            continue
        postings.append(RawJobPosting(
            job_title=title,
            company_name=company,
            job_description=str(item.get("description") or item.get("job_description") or "")[:POSTING_DESCRIPTION_MAX_CHARS],
            job_url=_sanitize_job_url(str(item.get("url") or item.get("job_url") or "")),
            location=item.get("location"),
            source_id=source["id"],
        ))
    return postings


def _split_rss_title(title: str, title_format: str) -> tuple[str, str]:
    """Split an RSS entry title into (job_title, company) using the format
    declared on its source (`config.title_format`, see RSS_TITLE_FORMATS).

    RSS_TITLE_FORMAT_NONE — or any unknown value — never splits: returns
    (title, ""). RSS_TITLE_FORMAT_COMPANY_COLON_TITLE splits "Company: Job
    Title" on the FIRST ": " only, so a colon inside the job title survives.
    RSS_TITLE_FORMAT_TITLE_DASH_COMPANY splits "Job Title - Company" on the
    LAST " - " only, so a dash inside the job title survives.
    A title that doesn't match its declared format isn't guessed at either:
    it comes back whole, with an empty company."""
    title = title.strip()
    if title_format == RSS_TITLE_FORMAT_COMPANY_COLON_TITLE:
        company, sep, job_title = title.partition(": ")
        if sep and company.strip() and job_title.strip():
            return job_title.strip(), company.strip()
    elif title_format == RSS_TITLE_FORMAT_TITLE_DASH_COMPANY:
        job_title, sep, company = title.rpartition(" - ")
        if sep and company.strip() and job_title.strip():
            return job_title.strip(), company.strip()
    return title, ""


# TEMPORARY — the global heuristic `_split_rss_title` used before
# title_format existed. Leads saved under it carry a fingerprint computed
# from its (often wrong) split; recomputing that fingerprint lets
# `_is_duplicate` still recognise them. Used ONLY for dedup (and the
# migration script's cross-check), never to split a title that gets stored.
#
# Keep both functions for as long as a restore is possible — not just until
# scripts/migrations/fix_rss_lead_titles.py has run with --apply:
# `--restore` puts leads back on their legacy fingerprint, and these are the
# only thing that stops the next scan from saving them again as new leads.
# Remove them (and the script) only once its backup is no longer needed.
def _legacy_split_rss_title(title: str) -> tuple[str, str]:
    for sep in (" at ", " - ", " | "):
        if sep in title:
            job_title, _, company = title.partition(sep)
            return job_title.strip(), company.strip()
    return title.strip(), ""


def _legacy_rss_fingerprint(raw_title: str) -> str:
    job_title, company = _legacy_split_rss_title(raw_title)
    return compute_fingerprint(company, job_title)


async def _scan_rss(source: Dict[str, Any], keywords: List[str]) -> List[RawJobPosting]:
    config = source.get("config") or {}
    feed_url = config.get("feed_url")
    if not feed_url:
        _report_source_problem("falta la URL del feed (feed_url)")
        return []
    title_format = config.get("title_format") or RSS_TITLE_FORMAT_NONE

    # Fetch the feed ourselves (SSRF-checked) and hand feedparser raw bytes,
    # never the URL. feedparser.parse() treats a string argument that isn't
    # a recognized URL as a local file path — passing it feed_url directly
    # would let a source's feed_url (e.g. "/etc/passwd" or "file:///etc/passwd")
    # make the backend read an arbitrary local file. Bytes input has no such
    # local-file fallback.
    try:
        async with httpx.AsyncClient(timeout=SOURCE_FETCH_TIMEOUT_SECONDS) as client:
            status_code, feed_content = await url_safety.safe_get_bytes(
                client, feed_url, max_bytes=MAX_SOURCE_RESPONSE_BYTES,
            )
            if status_code >= 400:
                raise ValueError(f"HTTP {status_code}")
    except Exception as exc:
        logger.warning("job_scout: RSS source %s failed to fetch: %s", source.get("id"), exc)
        _report_source_problem(_fetch_failure_message(exc))
        return []
    _report_if_truncated(feed_content)

    try:
        parsed = await asyncio.wait_for(
            asyncio.to_thread(feedparser.parse, feed_content),
            timeout=SOURCE_FETCH_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        logger.warning("job_scout: RSS source %s failed to parse: %s", source.get("id"), exc)
        _report_source_problem(f"no se pudo leer el feed: {exc}")
        return []
    # feedparser doesn't raise on HTML or garbage: it just finds no feed version.
    if not getattr(parsed, "version", "") and not getattr(parsed, "entries", None):
        _report_source_problem("el contenido no es un feed RSS/Atom válido")
        return []

    postings: List[RawJobPosting] = []
    for entry in list(getattr(parsed, "entries", []) or [])[:MAX_RESULTS_PER_SOURCE]:
        raw_title = (getattr(entry, "title", "") or "").strip()
        job_title, company = _split_rss_title(raw_title, title_format)
        job_url = _sanitize_job_url(getattr(entry, "link", "") or "")
        # From the FULL summary, before the 600-char cut below. Never rejects
        # the entry: no domain (or any error) just leaves it None.
        try:
            company_domain = company_domain_service.company_domain_from_description(getattr(entry, "summary", "") or "")
        except Exception:
            company_domain = None
        try:
            posting = RawJobPosting(
                job_title=job_title,
                company_name=company,
                job_description=(getattr(entry, "summary", "") or "")[:POSTING_DESCRIPTION_MAX_CHARS],
                job_url=job_url,
                source_id=source["id"],
                raw_title=raw_title,
                company_domain=company_domain,
                company_domain_source="rss_url_line" if company_domain else None,
            )
        except ValidationError as exc:
            # One bad entry is skipped, never the rest of the feed. The
            # reason is logged per field (e.g. "job_title: ... must not be
            # empty") — never the entry's values themselves.
            reason = "; ".join(
                f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}" for error in exc.errors()
            )
            logger.warning(
                "job_scout: RSS source %s: skipping invalid entry (link=%r): %s",
                source.get("id"), job_url, reason,
            )
            continue
        postings.append(posting)
    return postings


async def _robots_txt_allows(url: str) -> bool:
    """Best-effort robots.txt check — a courtesy check, not a legal opinion.
    Fails OPEN on any error fetching/parsing robots.txt (an unreachable
    robots.txt does not by itself forbid scraping), but respects an explicit
    Disallow when robots.txt is reachable and parses."""
    parsed_url = urlparse(url)
    if not parsed_url.scheme or not parsed_url.netloc:
        return True
    robots_url = f"{parsed_url.scheme}://{parsed_url.netloc}/robots.txt"
    try:
        async with httpx.AsyncClient(timeout=SCRAPER_ROBOTS_TXT_TIMEOUT_SECONDS) as client:
            status_code, body = await url_safety.safe_get_bytes(
                client, robots_url, headers={"User-Agent": SCRAPER_USER_AGENT},
                max_bytes=MAX_SOURCE_RESPONSE_BYTES,
            )
        if status_code >= 400:
            return True
        parser = urllib.robotparser.RobotFileParser()
        parser.parse(body.decode("utf-8", errors="replace").splitlines())
        return parser.can_fetch(SCRAPER_USER_AGENT, url)
    except url_safety.UnsafeUrlError:
        # Unlike an unreachable/erroring robots.txt (fail open, below),
        # an unsafe target is a real block — the main content fetch would
        # be blocked the same way anyway, this just fails a step earlier.
        return False
    except Exception:
        return True


async def _scan_scraper(source: Dict[str, Any], keywords: List[str]) -> List[RawJobPosting]:
    """Scrapes a page using CSS selectors the user configured on the
    JobSource (`config.selectors`). The target URL and selectors are chosen
    by the user of this system, not by NoonDalton — compliance with that
    site's terms of use is the user's responsibility. This adapter only adds
    baseline courtesy: an identifiable User-Agent, a robots.txt check, and a
    minimum delay between requests; it does not vet whether scraping a given
    site is permitted."""
    config = source.get("config") or {}
    url = config.get("url")
    selectors = config.get("selectors") or {}
    if not url or not selectors.get("item"):
        _report_source_problem("falta la URL o el selector de avisos (url, selectors.item)")
        return []

    if not await _robots_txt_allows(url):
        logger.warning("job_scout: scraper source %s blocked by robots.txt", source.get("id"))
        _report_source_problem("bloqueada por robots.txt")
        return []

    html: bytes = b""
    try:
        async with httpx.AsyncClient(
            timeout=SOURCE_FETCH_TIMEOUT_SECONDS,
            headers={"User-Agent": SCRAPER_USER_AGENT},
        ) as client:
            status_code, html = await url_safety.safe_get_bytes(
                client, url, max_bytes=MAX_SOURCE_RESPONSE_BYTES,
            )
            if status_code >= 400:
                raise ValueError(f"HTTP {status_code}")
            _report_if_truncated(html)
    except Exception as exc:
        logger.warning("job_scout: scraper source %s failed: %s", source.get("id"), exc)
        _report_source_problem(_fetch_failure_message(exc))
        return []
    finally:
        # Courtesy delay even on failure — keep request cadence to this host
        # predictable regardless of outcome.
        await asyncio.sleep(SCRAPER_MIN_DELAY_SECONDS)

    soup = BeautifulSoup(html, "html.parser")
    items = soup.select(selectors["item"])[:MAX_RESULTS_PER_SOURCE]

    def _text(item, selector_key: str) -> str:
        selector = selectors.get(selector_key)
        if not selector:
            return ""
        el = item.select_one(selector)
        return el.get_text(strip=True) if el else ""

    postings: List[RawJobPosting] = []
    for item in items:
        title = _text(item, "title")
        company = _text(item, "company")
        if not title or not company:
            continue
        link_el = item.select_one(selectors.get("link", "a")) if selectors.get("link", "a") else None
        link = link_el.get("href") if link_el else ""
        postings.append(RawJobPosting(
            job_title=title,
            company_name=company,
            job_description=_text(item, "description")[:POSTING_DESCRIPTION_MAX_CHARS],
            job_url=_sanitize_job_url(urljoin(url, link) if link else url),
            source_id=source["id"],
        ))
    return postings


# JSearch (RapidAPI) aggregates LinkedIn, Indeed and other boards. Unlike the
# generic API adapter, its URL and auth headers are fixed here — the user only
# supplies the api_key (encrypted at rest) and a few query settings.
def _jsearch_jobs(payload: Any) -> List[Any]:
    """The postings of one JSearch response: `data.jobs`, or `data` itself
    when the provider returns it as a list."""
    if not isinstance(payload, dict):
        return []
    data = payload.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("jobs"), list):
        return data["jobs"]
    return []


def _jsearch_apply_link(item: Dict[str, Any]) -> str:
    link = str(item.get("job_apply_link") or "").strip()
    if link:
        return link
    options = item.get("apply_options")
    if isinstance(options, list) and options and isinstance(options[0], dict):
        return str(options[0].get("apply_link") or "").strip()
    return ""


def _jsearch_location(item: Dict[str, Any]) -> Optional[str]:
    """`City, Country` when both are given, else `job_location`; None when
    nothing usable is left (empty, or the provider's "Anywhere")."""
    city = str(item.get("job_city") or "").strip()
    country = str(item.get("job_country") or "").strip()
    location = f"{city}, {country}" if city and country else str(item.get("job_location") or "").strip()
    if not location or location.lower() == "anywhere":
        return None
    return location


def _jsearch_failure_message(exc: Exception) -> str:
    # Never includes the request itself: its headers carry the api_key.
    if isinstance(exc, httpx.TimeoutException):
        return f"tiempo de espera agotado ({JSEARCH_FETCH_TIMEOUT_SECONDS} s)"
    return _fetch_failure_message(exc)


def _jsearch_status_message(status_code: int) -> str:
    if status_code == 403:
        return "clave de API inválida o sin suscripción a JSearch (HTTP 403)"
    if status_code == 429:
        return "cuota de JSearch agotada (HTTP 429)"
    return f"JSearch respondió HTTP {status_code}"


async def _scan_jsearch(source: Dict[str, Any], keywords: List[str]) -> List[RawJobPosting]:
    config = source.get("config") or {}
    api_key = _resolve_source_secrets(source).get("api_key")
    if not api_key:
        _report_source_problem("falta la clave de API (api_key)")
        return []
    query = " ".join(str(k).strip() for k in keywords[:5] if str(k).strip())
    if not query:
        _report_source_problem("no hay palabras clave configuradas para la búsqueda")
        return []

    try:
        num_pages = int(config.get("num_pages") or JSEARCH_DEFAULT_NUM_PAGES)
    except (TypeError, ValueError):
        num_pages = JSEARCH_DEFAULT_NUM_PAGES
    num_pages = max(1, min(num_pages, JSEARCH_MAX_PAGES))
    base_params: Dict[str, Any] = {
        "query": query,
        "country": config.get("country") or JSEARCH_DEFAULT_COUNTRY,
        "language": config.get("language") or JSEARCH_DEFAULT_LANGUAGE,
        "num_pages": 1,
    }
    if config.get("date_posted"):
        base_params["date_posted"] = config["date_posted"]
    headers = {"X-RapidAPI-Key": api_key, "X-RapidAPI-Host": JSEARCH_API_HOST}

    postings: List[RawJobPosting] = []
    async with httpx.AsyncClient(timeout=JSEARCH_FETCH_TIMEOUT_SECONDS) as client:
        # One request per page, so the run budget and the per-source cap are
        # checked before paying for each extra page.
        for page in range(1, num_pages + 1):
            if page > 1 and (len(postings) >= MAX_RESULTS_PER_SOURCE or _run_budget_exhausted()):
                break
            message: Optional[str] = None
            try:
                status_code, body = await url_safety.safe_get_bytes(
                    client, JSEARCH_SEARCH_URL, headers=headers, params={**base_params, "page": page},
                    max_bytes=MAX_SOURCE_RESPONSE_BYTES,
                )
                if status_code >= 400:
                    message = _jsearch_status_message(status_code)
                else:
                    _report_if_truncated(body)
                    payload = json.loads(body)
            except Exception as exc:
                message = _jsearch_failure_message(exc)
            if message is not None:
                logger.warning("job_scout: JSearch source %s page %d failed: %s", source.get("id"), page, message)
                # Only the first page failing means nothing was read from the source.
                if page == 1:
                    _report_source_problem(message)
                else:
                    _report_source_problem(f"página {page}: {message}", fatal=False)
                break

            jobs = _jsearch_jobs(payload)
            if not jobs:
                break  # no more results: later pages would be empty too
            for item in jobs:
                if len(postings) >= MAX_RESULTS_PER_SOURCE:
                    break
                if not isinstance(item, dict):
                    continue
                title = str(item.get("job_title") or "").strip()
                company = str(item.get("employer_name") or "").strip()
                if not title or not company:
                    continue
                postings.append(RawJobPosting(
                    job_title=title,
                    company_name=company,
                    job_description=str(item.get("job_description") or "")[:POSTING_DESCRIPTION_MAX_CHARS],
                    job_url=_sanitize_job_url(_jsearch_apply_link(item)),
                    location=_jsearch_location(item),
                    source_id=source["id"],
                ))
    return postings


async def _scan_source(source: Dict[str, Any], keywords: List[str]) -> List[RawJobPosting]:
    source_type = SourceType(source["source_type"])
    if source_type == SourceType.API:
        return await _scan_api(source, keywords)
    if source_type == SourceType.RSS:
        return await _scan_rss(source, keywords)
    if source_type == SourceType.SCRAPER:
        return await _scan_scraper(source, keywords)
    if source_type == SourceType.JSEARCH:
        return await _scan_jsearch(source, keywords)
    return []  # WEBHOOK is push, not pull — nothing to scan here.


# ── Relevance scoring (DeepSeek, batched) ───────────────────────────────────
def _clean_json_response(text: str) -> str:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```")[1] if "```" in cleaned[3:] else cleaned[3:]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    return cleaned.strip()


def _score_prompt(postings: List[RawJobPosting], keywords: List[str]) -> str:
    services = ", ".join(keywords) if keywords else "outsourcing/BPO en general"
    items = [
        {
            "id": idx,
            "job_title": posting.job_title,
            "company": posting.company_name,
            "description": posting.job_description,
        }
        for idx, posting in enumerate(postings)
    ]
    return (
        f"Servicios de NoonDalton: {services}\n\n"
        "Analiza cada una de estas vacantes y determina si la empresa podría "
        "beneficiarse de los servicios de NoonDalton (es decir, si la vacante "
        "indica que la empresa busca talento que NoonDalton podría proveer "
        "como servicio externalizado).\n\n"
        f"Vacantes:\n{json.dumps(items, ensure_ascii=False)}\n\n"
        'Responde con un array JSON, un objeto por cada "id" de arriba, en este formato exacto:\n'
        '[\n'
        '  {"id": 0, "relevance_score": 0.0, "matched_keywords": ["keyword1"], '
        '"reasoning": "Explicación breve", "suggested_value_prop": "Propuesta de valor"}\n'
        ']'
    )


async def _call_deepseek_for_scores(postings: List[RawJobPosting], keywords: List[str]) -> List[Dict[str, Any]] | None:
    prompt = _score_prompt(postings, keywords)
    try:
        raw = await deepseek_service.generate_text(
            prompt,
            system_prompt=_SCORE_SYSTEM_PROMPT,
            temperature=0.2,
            timeout=RELEVANCE_SCORING_TIMEOUT_SECONDS,
        )
        parsed = json.loads(_clean_json_response(raw))
        if not isinstance(parsed, list):
            return None
        return parsed
    except Exception as exc:
        logger.warning("job_scout: DeepSeek scoring call failed: %s", exc)
        return None


async def score_relevance_batch(
    postings: List[RawJobPosting], keywords: List[str]
) -> Dict[int, Dict[str, Any]]:
    """Score a batch of postings in a single DeepSeek call (keyed by the
    `id` each posting was given in the prompt). Falls back to scoring each
    posting individually if the batch response doesn't parse cleanly or
    comes back with a different number of entries than requested — a
    malformed batch never silently drops postings from scoring."""
    if not postings:
        return {}

    parsed = await _call_deepseek_for_scores(postings, keywords)
    if parsed is not None:
        results = {entry["id"]: entry for entry in parsed if isinstance(entry, dict) and "id" in entry}
        if len(results) == len(postings):
            return results
        logger.warning(
            "job_scout: batch scoring returned %d/%d results, falling back to per-item scoring",
            len(results), len(postings),
        )

    results = {}
    for idx, posting in enumerate(postings):
        single = await _call_deepseek_for_scores([posting], keywords)
        if single and isinstance(single[0], dict):
            results[idx] = single[0]
        else:
            results[idx] = {"relevance_score": 0.0, "matched_keywords": [], "reasoning": "scoring_failed"}
    return results


# ── Orchestration for one PipelineConfig ────────────────────────────────────
async def scan_all_sources(pipeline_config: Dict[str, Any], run_id: str) -> Dict[str, Any]:
    """Scan every enabled source of a PipelineConfig, score and persist new
    leads. Returns {leads_found, leads_new, errors, partial, all_sources_failed}.

    `pipeline_config` is the raw Firestore document (has "id" and "userId",
    not the snake_case PipelineConfig schema field names — matches how
    routers/pipeline.py already works with these docs).

    Bounded by RUN_TIME_BUDGET_SECONDS / MAX_RESULTS_PER_SOURCE /
    MAX_RESULTS_PER_RUN (app.core.pipeline_constants) so this fits inside a
    single Vercel function invocation once this runs there — a source that
    fails or times out marks the run PARTIAL, it never aborts the whole run.
    """
    pipeline_config_id = pipeline_config["id"]
    user_id = pipeline_config.get("userId")
    keywords = pipeline_config.get("keywords") or []
    excluded_companies = {
        c.strip().lower() for c in (pipeline_config.get("excluded_companies") or [])
    }
    sources = [s for s in (pipeline_config.get("sources") or []) if s.get("enabled")]

    started_at = time.monotonic()
    evaluated_count = 0
    leads_new = 0
    errors: List[Dict[str, Any]] = []
    partial = False
    failed_sources = 0
    # Fingerprints already seen in this run: _is_duplicate only knows leads saved
    # before it, so a posting repeated within this run would become a second lead.
    seen_fingerprints: set = set()

    for source in sources:
        if evaluated_count >= MAX_RESULTS_PER_RUN:
            partial = True
            break
        if time.monotonic() - started_at >= RUN_TIME_BUDGET_SECONDS:
            partial = True
            errors.append({
                "agent": "job_scout",
                "source_id": source.get("id"),
                "message": "Run time budget exhausted before this source could start.",
                "timestamp": now_utc().isoformat(),
            })
            break

        problems: List[Dict[str, Any]] = []
        problems_token = _source_problems.set(problems)
        deadline_token = _run_deadline.set(started_at + RUN_TIME_BUDGET_SECONDS)
        try:
            postings = await _scan_source(source, keywords)
        except Exception as exc:
            partial = True
            failed_sources += 1
            logger.warning("job_scout: source %s raised: %s", source.get("id"), exc)
            errors.append({
                "agent": "job_scout",
                "source_id": source.get("id"),
                "source_name": source.get("name"),
                "message": str(exc),
                "timestamp": now_utc().isoformat(),
            })
            continue
        finally:
            _source_problems.reset(problems_token)
            _run_deadline.reset(deadline_token)

        for problem in problems:
            partial = True
            errors.append({
                "agent": "job_scout",
                "source_id": source.get("id"),
                "source_name": source.get("name"),
                "message": problem["message"],
                "timestamp": now_utc().isoformat(),
            })
        if any(problem["fatal"] for problem in problems):
            failed_sources += 1

        postings = postings[:MAX_RESULTS_PER_SOURCE]
        postings = [p for p in postings if p.company_name.strip().lower() not in excluded_companies]

        candidates: List[tuple] = []
        for posting in postings:
            if evaluated_count + len(candidates) >= MAX_RESULTS_PER_RUN:
                partial = True
                break
            fingerprint = compute_fingerprint(posting.company_name, posting.job_title)
            if fingerprint in seen_fingerprints:
                continue
            seen_fingerprints.add(fingerprint)
            known_fingerprints = [fingerprint]
            if posting.raw_title is not None:
                known_fingerprints.append(_legacy_rss_fingerprint(posting.raw_title))
            if await _is_duplicate(pipeline_config_id, known_fingerprints):
                continue
            candidates.append((posting, fingerprint))

        for batch_start in range(0, len(candidates), RELEVANCE_SCORING_BATCH_SIZE):
            if time.monotonic() - started_at >= RUN_TIME_BUDGET_SECONDS:
                partial = True
                errors.append({
                    "agent": "job_scout",
                    "source_id": source.get("id"),
                    "message": "Run time budget exhausted during candidate scoring.",
                    "timestamp": now_utc().isoformat(),
                })
                break
            batch = candidates[batch_start:batch_start + RELEVANCE_SCORING_BATCH_SIZE]
            scores = await score_relevance_batch([c[0] for c in batch], keywords)
            for idx, (posting, fingerprint) in enumerate(batch):
                result = scores.get(idx, {})
                try:
                    score = float(result.get("relevance_score") or 0.0)
                except (TypeError, ValueError):
                    score = 0.0
                score = max(0.0, min(1.0, score))
                evaluated_count += 1

                if score < RELEVANCE_SCORE_THRESHOLD:
                    continue

                await leads_repo.create({
                    "pipeline_config_id": pipeline_config_id,
                    "user_id": user_id,
                    "job_title": posting.job_title,
                    "company_name": posting.company_name,
                    "job_description": posting.job_description,
                    "job_url": posting.job_url,
                    "source_id": posting.source_id,
                    "location": posting.location,
                    "salary_range": posting.salary_range,
                    "posted_date": posting.posted_date,
                    "matched_keywords": result.get("matched_keywords") or [],
                    "relevance_score": score,
                    "status": LeadStatus.NEW.value,
                    "pipeline_run_id": run_id,
                    "fingerprint": fingerprint,
                    "raw_title": posting.raw_title,
                    "company_domain": posting.company_domain,
                    "company_domain_source": posting.company_domain_source,
                })
                leads_new += 1

    return {
        "leads_found": evaluated_count,
        "leads_new": leads_new,
        "errors": errors,
        "partial": partial,
        "all_sources_failed": bool(sources) and failed_sources == len(sources),
    }


# ── PipelineRun bookkeeping ──────────────────────────────────────────────────
# Shared by the manual-trigger router endpoint (sync fallback path) and the
# Celery task, so a run's outcome is written to Firestore the same way
# regardless of who invoked scan_all_sources.
async def finalize_run(run_id: str, result: Dict[str, Any]) -> None:
    """Write scan_all_sources' result onto its PipelineRun doc."""
    if result.get("all_sources_failed"):
        status_value = PipelineRunStatus.FAILED.value
    elif result["partial"]:
        status_value = PipelineRunStatus.PARTIAL.value
    else:
        status_value = PipelineRunStatus.COMPLETED.value
    await pipeline_runs_repo.update(run_id, {
        "status": status_value,
        "leads_found": result["leads_found"],
        "leads_new": result["leads_new"],
        "errors": result["errors"],
        "agent1_completed_at": now_utc(),
        "completed_at": now_utc(),
    })


async def fail_run(run_id: str, message: str) -> None:
    """Mark a run FAILED when scan_all_sources itself raised (a bug, not a
    per-source error — those are captured inside `result["errors"]` and
    still produce a COMPLETED/PARTIAL run, not a FAILED one)."""
    await pipeline_runs_repo.update(run_id, {
        "status": PipelineRunStatus.FAILED.value,
        "errors": [{
            "agent": "job_scout",
            "message": message,
            "timestamp": now_utc().isoformat(),
        }],
        "completed_at": now_utc(),
    })
