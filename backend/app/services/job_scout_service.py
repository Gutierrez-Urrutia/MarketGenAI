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
from typing import Any, Dict, List
from urllib.parse import urljoin, urlparse

import feedparser
import httpx
from bs4 import BeautifulSoup

from app.core import url_safety
from app.core.pipeline_constants import (
    MAX_RESULTS_PER_RUN,
    MAX_RESULTS_PER_SOURCE,
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
from app.schemas.pipeline import SOURCE_TYPE_SECRET_CONFIG_FIELDS, PipelineRunStatus, SourceType
from app.services import deepseek_service, encryption_service
from app.services.firestore_service import leads_repo, now_utc, pipeline_runs_repo

logger = logging.getLogger("marketgen.pipeline.job_scout")

_SCORE_SYSTEM_PROMPT = (
    "Eres un analista de ventas B2B para NoonDalton, empresa de outsourcing/BPO. "
    "Respondes ÚNICAMENTE con un array JSON válido, sin texto adicional antes ni después."
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


async def _is_duplicate(pipeline_config_id: str, fingerprint: str) -> bool:
    """Two different pipeline configs (two different clients) can each have
    their own Lead for the same posting — dedup only looks within this
    config's own leads, never across all configs."""
    existing = await leads_repo.list(
        filters=[
            ("pipeline_config_id", "==", pipeline_config_id),
            ("fingerprint", "==", fingerprint),
        ],
        limit=1,
    )
    return bool(existing)


# ── Source adapters ──────────────────────────────────────────────────────────
async def _scan_api(source: Dict[str, Any], keywords: List[str]) -> List[RawJobPosting]:
    config = source.get("config") or {}
    base_url = config.get("base_url")
    if not base_url:
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
            resp = await url_safety.safe_get(client, base_url, headers=headers, params=params)
            resp.raise_for_status()
            payload = resp.json()
    except Exception as exc:
        logger.warning("job_scout: API source %s failed: %s", source.get("id"), exc)
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


def _split_rss_title(title: str) -> tuple[str, str]:
    """Best-effort split of a job RSS entry title into (job_title, company).
    Job RSS feeds commonly format titles as "Job Title at Company" or
    "Job Title - Company"; falls back to (title, "") if no separator is found."""
    for sep in (" at ", " - ", " | "):
        if sep in title:
            job_title, _, company = title.partition(sep)
            return job_title.strip(), company.strip()
    return title.strip(), ""


async def _scan_rss(source: Dict[str, Any], keywords: List[str]) -> List[RawJobPosting]:
    config = source.get("config") or {}
    feed_url = config.get("feed_url")
    if not feed_url:
        return []

    # Fetch the feed ourselves (SSRF-checked) and hand feedparser raw bytes,
    # never the URL. feedparser.parse() treats a string argument that isn't
    # a recognized URL as a local file path — passing it feed_url directly
    # would let a source's feed_url (e.g. "/etc/passwd" or "file:///etc/passwd")
    # make the backend read an arbitrary local file. Bytes input has no such
    # local-file fallback.
    try:
        async with httpx.AsyncClient(timeout=SOURCE_FETCH_TIMEOUT_SECONDS) as client:
            resp = await url_safety.safe_get(client, feed_url)
            resp.raise_for_status()
            feed_content = resp.content
    except Exception as exc:
        logger.warning("job_scout: RSS source %s failed to fetch: %s", source.get("id"), exc)
        return []

    try:
        parsed = await asyncio.wait_for(
            asyncio.to_thread(feedparser.parse, feed_content),
            timeout=SOURCE_FETCH_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        logger.warning("job_scout: RSS source %s failed to parse: %s", source.get("id"), exc)
        return []

    postings: List[RawJobPosting] = []
    for entry in list(getattr(parsed, "entries", []) or [])[:MAX_RESULTS_PER_SOURCE]:
        title = getattr(entry, "title", "") or ""
        job_title, company = _split_rss_title(title)
        if not job_title:
            continue
        postings.append(RawJobPosting(
            job_title=job_title,
            company_name=company,
            job_description=(getattr(entry, "summary", "") or "")[:POSTING_DESCRIPTION_MAX_CHARS],
            job_url=_sanitize_job_url(getattr(entry, "link", "") or ""),
            source_id=source["id"],
        ))
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
            resp = await url_safety.safe_get(client, robots_url, headers={"User-Agent": SCRAPER_USER_AGENT})
        if resp.status_code >= 400:
            return True
        parser = urllib.robotparser.RobotFileParser()
        parser.parse(resp.text.splitlines())
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
        return []

    if not await _robots_txt_allows(url):
        logger.warning("job_scout: scraper source %s blocked by robots.txt", source.get("id"))
        return []

    html = ""
    try:
        async with httpx.AsyncClient(
            timeout=SOURCE_FETCH_TIMEOUT_SECONDS,
            headers={"User-Agent": SCRAPER_USER_AGENT},
        ) as client:
            resp = await url_safety.safe_get(client, url)
            resp.raise_for_status()
            html = resp.text
    except Exception as exc:
        logger.warning("job_scout: scraper source %s failed: %s", source.get("id"), exc)
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


async def _scan_source(source: Dict[str, Any], keywords: List[str]) -> List[RawJobPosting]:
    source_type = SourceType(source["source_type"])
    if source_type == SourceType.API:
        return await _scan_api(source, keywords)
    if source_type == SourceType.RSS:
        return await _scan_rss(source, keywords)
    if source_type == SourceType.SCRAPER:
        return await _scan_scraper(source, keywords)
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
    leads. Returns {leads_found, leads_new, errors, partial}.

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

        try:
            postings = await _scan_source(source, keywords)
        except Exception as exc:
            partial = True
            logger.warning("job_scout: source %s raised: %s", source.get("id"), exc)
            errors.append({
                "agent": "job_scout",
                "source_id": source.get("id"),
                "message": str(exc),
                "timestamp": now_utc().isoformat(),
            })
            continue

        postings = postings[:MAX_RESULTS_PER_SOURCE]
        postings = [p for p in postings if p.company_name.strip().lower() not in excluded_companies]

        candidates: List[tuple] = []
        for posting in postings:
            if evaluated_count + len(candidates) >= MAX_RESULTS_PER_RUN:
                partial = True
                break
            fingerprint = compute_fingerprint(posting.company_name, posting.job_title)
            if await _is_duplicate(pipeline_config_id, fingerprint):
                continue
            candidates.append((posting, fingerprint))

        for batch_start in range(0, len(candidates), RELEVANCE_SCORING_BATCH_SIZE):
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
                })
                leads_new += 1

    return {
        "leads_found": evaluated_count,
        "leads_new": leads_new,
        "errors": errors,
        "partial": partial,
    }


# ── PipelineRun bookkeeping ──────────────────────────────────────────────────
# Shared by the manual-trigger router endpoint (sync fallback path) and the
# Celery task, so a run's outcome is written to Firestore the same way
# regardless of who invoked scan_all_sources.
async def finalize_run(run_id: str, result: Dict[str, Any]) -> None:
    """Write scan_all_sources' result onto its PipelineRun doc."""
    status_value = (
        PipelineRunStatus.PARTIAL.value if result["partial"] else PipelineRunStatus.COMPLETED.value
    )
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
