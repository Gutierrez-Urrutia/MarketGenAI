"""Tunable constants for the prospecting pipeline.

Single source of truth so these values are never hand-copied between a
service, a schema and the frontend. See analisis-worker-serverless.md
(sección 11) for the reasoning behind keeping scheduling constants in one
place — this module is that place, but scheduling constants themselves
(CRON_BASE_INTERVAL_HOURS, SCAN_FREQUENCY_OPTIONS_HOURS, tolerance, lock
timeout, etc.) are NOT defined yet: they depend on which Vercel plan the
client confirms and land with the Fase 5-6 scheduler, not before.
"""
from __future__ import annotations

# ── Agente 1 — Job Scout ────────────────────────────────────────────────────
# Below this relevance score, a posting is discarded (never persisted as a
# Lead) — see plan-pipeline-3-agentes.md §3.1.
RELEVANCE_SCORE_THRESHOLD = 0.6

# Per-source fetch budget. A single slow/hanging source must not be able to
# consume the whole run's time budget below.
SOURCE_FETCH_TIMEOUT_SECONDS = 20

# Hard cap on how many bytes of a single source response (API JSON, scraped
# HTML, RSS feed, robots.txt) are ever held in memory. Enforced by streaming
# the response and cutting off the read as soon as this is exceeded
# (app.core.url_safety.safe_get_bytes) — not by loading the full body first
# and measuring it afterwards, which would already have paid the memory
# cost a misbehaving/malicious source could use to exhaust the worker.
MAX_SOURCE_RESPONSE_BYTES = 5 * 1024 * 1024  # 5 MB

# Caps to keep one run bounded regardless of how a source is configured.
MAX_RESULTS_PER_SOURCE = 30
MAX_RESULTS_PER_RUN = 100

# Wall-clock budget for a whole manual run. Vercel Hobby caps a function
# invocation at 300s (analisis-worker-serverless.md §1) — this leaves ~60s
# of margin for persistence and an orderly PARTIAL close-out. A source that
# would start after this budget is skipped for this run, not force-run.
RUN_TIME_BUDGET_SECONDS = 240

# DeepSeek relevance scoring: postings are scored in batches (one DeepSeek
# call scores up to N postings at once) instead of one call per posting, to
# cut both latency (fewer round trips inside RUN_TIME_BUDGET_SECONDS) and
# LLM cost. See job_scout_service.py `score_relevance_batch` for the
# per-item fallback when a batch response fails to parse.
RELEVANCE_SCORING_BATCH_SIZE = 8
RELEVANCE_SCORING_TIMEOUT_SECONDS = 45

# Prompt size guard: postings are truncated to this many characters of
# description before being sent to DeepSeek, so a batch of
# RELEVANCE_SCORING_BATCH_SIZE postings stays a bounded prompt size.
POSTING_DESCRIPTION_MAX_CHARS = 600

# ── Scraper adapter — responsible scraping ──────────────────────────────────
# Identifies the bot to site operators (robots.txt, server logs) instead of
# spoofing a browser user-agent. The scraper source's URL and selectors are
# configured by the user of this system, not by NoonDalton — respecting the
# target site's terms of use is the user's responsibility; this bot only
# adds baseline courtesy (own UA, robots.txt check, rate limiting), it does
# not vet whether scraping a given site is permitted.
SCRAPER_USER_AGENT = "NoonDaltonProspectingBot/1.0 (+https://noondalton.com/bot)"
SCRAPER_MIN_DELAY_SECONDS = 2.0
SCRAPER_ROBOTS_TXT_TIMEOUT_SECONDS = 5
