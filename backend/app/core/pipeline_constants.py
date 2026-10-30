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

# A run still marked `running` this long after it started is presumed dead (worker
# crashed / function killed) and stops blocking new runs on the same config.
# The 120s margin over RUN_TIME_BUDGET_SECONDS covers persistence and Celery
# queueing delay; 240 + 120 = 6 minutes. Used as the TTL of the per-config run
# lock (app.services.firestore_service.PipelineRunLocksRepo).
RUN_CONSIDERED_DEAD_AFTER_SECONDS = RUN_TIME_BUDGET_SECONDS + 120

# Real upper bound for handing a run to Celery (`task.delay`). With the broker
# down, a bare `.delay()` was measured at ~109 s (44 connection attempts of ~2 s
# on Windows) and, called on the event loop, froze the whole API for that long.
# It now runs in a worker thread and the request gives up after this many
# seconds and runs the scan inline instead (routers/pipeline._enqueue_scan).
TASK_ENQUEUE_TIMEOUT_SECONDS = 5

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

# ── JSearch adapter (RapidAPI — LinkedIn, Indeed and other job boards) ──────
# The endpoint is fixed here, never taken from the user's source config.
# /search-v2 replaced /search (now 404); it pages by cursor, not page numbers.
JSEARCH_SEARCH_URL = "https://jsearch.p.rapidapi.com/search-v2"
JSEARCH_API_HOST = "jsearch.p.rapidapi.com"
# JSearch aggregates several boards per request and is slower than a plain
# feed, so it gets a longer per-request budget than SOURCE_FETCH_TIMEOUT_SECONDS.
# RUN_TIME_BUDGET_SECONDS still bounds the whole run.
JSEARCH_FETCH_TIMEOUT_SECONDS = 45
# Each page is a separate request (and a separate billed call on RapidAPI).
# Cap on the requests of one source per run, across all its keywords: enough
# for page 1 of every keyword.
JSEARCH_MAX_PAGES = 8
# JSearch matches a query as one phrase, so each keyword is its own query;
# only the first ones are used, and they share JSEARCH_MAX_PAGES.
JSEARCH_MAX_KEYWORDS = 8
# A source's num_pages: the depth per keyword (1..this). Never sent to JSearch.
JSEARCH_MAX_NUM_PAGES = 3
JSEARCH_DEFAULT_NUM_PAGES = 1
# Postings kept per keyword and per JSearch source, so that every keyword
# adds some (the first ones would otherwise fill the source cap alone).
# 8 x 5 = 40 still fits RUN_TIME_BUDGET_SECONDS with batched scoring; the
# other source types keep MAX_RESULTS_PER_SOURCE.
JSEARCH_MAX_RESULTS_PER_KEYWORD = 5
JSEARCH_MAX_RESULTS_PER_SOURCE = JSEARCH_MAX_KEYWORDS * JSEARCH_MAX_RESULTS_PER_KEYWORD
# A JSearch request is not started with less run budget than this left.
JSEARCH_MIN_REQUEST_SECONDS = 5
JSEARCH_DEFAULT_COUNTRY = "gb"
JSEARCH_DEFAULT_LANGUAGE = "en"
JSEARCH_DATE_POSTED_OPTIONS = ("all", "today", "3days", "week", "month")

# ── Agente 2 — Lead Researcher ──────────────────────────────────────────────
# Total budget for verifying one email address: every DNS query it makes
# (MX, then A/AAAA when there is no MX) shares this one deadline, so a single
# verification never takes longer than this — see
# email_verification_service.verify_email.
EMAIL_MX_TIMEOUT_SECONDS = 5

# Per-provider budget for one contact search (enrichment_service). Providers
# run concurrently, so a slow one costs at most this much and never delays
# the others. Same value as SOURCE_FETCH_TIMEOUT_SECONDS for Agente 1.
ENRICHMENT_PROVIDER_TIMEOUT_SECONDS = 20

# Contacts kept from a single provider per search; the rest are dropped (and
# logged) so one misbehaving provider can't flood a lead with contacts.
ENRICHMENT_MAX_CONTACTS_PER_PROVIDER = 50

# ── Hunter.io provider (Agente 2 — contacts by company domain) ──────────────
# Endpoints are fixed here, never taken from the user. The key travels only
# in the X-API-KEY header, never in the URL (httpx logs URLs).
HUNTER_DOMAIN_SEARCH_URL = "https://api.hunter.io/v2/domain-search"
HUNTER_ACCOUNT_URL = "https://api.hunter.io/v2/account"
# /account (free) is read once per provider instance, then the search runs:
# both together stay under ENRICHMENT_PROVIDER_TIMEOUT_SECONDS.
HUNTER_ACCOUNT_TIMEOUT_SECONDS = 5
HUNTER_SEARCH_TIMEOUT_SECONDS = 12
# A domain search costs 1 credit for 1 to 10 emails (none when it finds
# nothing), so one page of 10 per lead.
HUNTER_RESULTS_LIMIT = 10
HUNTER_EMAIL_TYPE = "personal"
# An empty seniority goes with operational staff (drivers, couriers): only
# senior and executive people are asked for.
HUNTER_SENIORITY = ("senior", "executive")
# Sent comma-separated as `department`; an empty tuple sends no filter.
HUNTER_DEPARTMENTS = ("executive", "management", "operations", "support", "procurement", "finance", "it")
# A Hunter response is a handful of emails: far below MAX_SOURCE_RESPONSE_BYTES.
HUNTER_MAX_RESPONSE_BYTES = 512 * 1024
# Characters of Hunter's own error text (errors[].details) kept for the logs.
HUNTER_ERROR_DETAIL_MAX_CHARS = 200
# Source page URLs kept per contact (sources[].uri).
HUNTER_MAX_SOURCE_URLS = 5
# Searching by company name (no domain), Hunter picks the domain itself. Its
# contacts are kept only when that domain matches the name at least this much
# (company_domain_validation_service.domain_name_match). Measured: matching
# pairs (hsbc.com / "HSBC Global Services", uniqlo.com / "Uniqlo", zigup.com /
# "ZIGUP plc", britishairways.com / "British Airways") all score 1.0; unrelated
# pairs score 0.0-0.286.
HUNTER_COMPANY_MATCH_MIN = 0.7
# Words that say nothing about which company it is. They are dropped from a
# company name before it is matched against the domain Hunter picked, so
# "HSBC Global Services" never matches services.com or global.com. A name
# made only of these words matches nothing. Accent-free and lowercase.
HUNTER_GENERIC_NAME_WORDS = frozenset({
    "services", "service", "global", "group", "holdings", "holding", "limited", "ltd", "plc",
    "inc", "incorporated", "company", "co", "corp", "corporation", "llc", "llp", "gmbh", "ag", "sa",
    "solutions", "international", "intl", "worldwide", "enterprises", "partners", "systems",
    "technologies", "technology", "consulting", "the", "and", "of",
    # Spanish
    "grupo", "servicios", "soluciones", "sociedad", "spa", "ltda", "compania", "de", "del", "la", "y",
})

# Email Verifier: 0.5 credit per address (a domain search costs 1).
HUNTER_EMAIL_VERIFIER_URL = "https://api.hunter.io/v2/email-verifier"
HUNTER_VERIFIER_TIMEOUT_SECONDS = 15
HUNTER_SEARCH_CREDIT_COST = 1.0
HUNTER_VERIFICATION_CREDIT_COST = 0.5
# Addresses verified per lead (only top contacts not already "valid").
HUNTER_MAX_VERIFICATIONS_PER_LEAD = 1

# ── Agente 2 — contact role, ranking and confidence ─────────────────────────
# app/services/contact_ranking_service.py. Titles and vacancy titles are
# matched as whole words/phrases after folding accents and case. All values
# below are initial values, to be tuned with real leads.

# Contacts delivered per lead.
RANK_TOP_N = 3

# Area of the vacancy (Lead.job_title / job_context): first area with a match.
VACANCY_AREA_KEYWORDS = {
    "customer_service": ("customer support", "customer service", "customer care", "customer experience",
                         "call center", "call centre", "contact center", "contact centre", "cx", "client services"),
    "sales_support": ("sales", "lead generation", "sdr", "business development", "crm"),
    "hr_recruitment": ("recruiter", "recruitment", "recruiting", "talent", "hr", "human resources"),
    "software_it": ("developer", "engineer", "software", "devops", "it support", "helpdesk", "help desk",
                    "infrastructure", "programmer"),
    "back_office": ("data entry", "back office", "admin", "administrative", "bookkeeping", "bookkeeper",
                    "accounts payable", "accounts receivable", "data processing"),
    "underwriting": ("underwriter", "underwriting", "loan", "mortgage"),
    "ecommerce": ("e commerce", "ecommerce", "order", "orders", "inventory", "fulfillment", "fulfilment", "shipping"),
    "insurance": ("claims", "insurance", "renewals", "policy"),
}

# Areas a contact's title can name (a title can name several).
CONTACT_TITLE_AREAS = {
    "customer": ("customer", "customers", "cx", "client", "clients", "contact center", "contact centre",
                 "call center", "call centre"),
    "operations": ("operations", "operational", "operating"),
    "technology": ("technology", "technical", "it", "engineering", "software", "digital", "information"),
    "finance": ("finance", "financial", "controller", "comptroller", "cfo", "accounting", "treasury"),
    "hr": ("hr", "human resources", "people", "talent", "chro"),
    "sales": ("sales", "revenue", "commercial", "business development"),
    "ecommerce": ("ecommerce", "e commerce", "fulfillment", "fulfilment", "supply chain", "logistics"),
    "risk": ("credit", "risk", "underwriting", "lending"),
    "claims": ("claims", "insurance"),
}

# Contact areas that make a department head (or manager) "the area's own"
# for each vacancy area. Finance is NOT here for back office: finance heads
# get their own tier (RANK_TIER_FINANCE) for FINANCE_VACANCY_AREAS.
VACANCY_AREA_CONTACT_AREAS = {
    "customer_service": ("customer", "operations"),
    "sales_support": ("sales",),
    "hr_recruitment": ("hr",),
    "software_it": ("technology",),
    "back_office": ("operations",),
    "underwriting": ("risk", "operations"),
    "ecommerce": ("ecommerce", "operations"),
    "insurance": ("claims", "operations"),
}
FINANCE_VACANCY_AREAS = ("back_office", "underwriting", "insurance")

# Title words of operational staff: such a contact is never delivered,
# unless the title also has a TITLE_LEADERSHIP_WORDS word ("Driver Manager").
# "officer" counts as operational unless it is a "chief ... officer".
OPERATIONAL_TITLE_WORDS = frozenset({
    "driver", "drivers", "courier", "messenger", "rider", "coordinator", "assistant", "associate",
    "agent", "representative", "clerk", "operator", "technician", "cashier", "officer",
})
TITLE_LEADERSHIP_WORDS = frozenset({
    "head", "director", "vp", "svp", "evp", "chief", "manager", "president", "owner", "founder",
    "cofounder", "supervisor", "controller", "comptroller",
})

EXECUTIVE_TITLE_PHRASES = ("ceo", "chief executive officer", "founder", "co founder", "cofounder", "owner",
                           "managing director", "president")
# Phrases that contain an executive word but are not executives.
EXECUTIVE_EXCLUDED_PHRASES = ("vice president", "product owner", "process owner")
# "chief <word> officer" with one of these words heads a function
# (department_head); any other chief officer is an executive.
CHIEF_FUNCTION_WORDS = frozenset({
    "operating", "operations", "financial", "finance", "technology", "technical", "information",
    "customer", "people", "human", "procurement", "commercial", "revenue", "experience",
})
FUNCTION_CHIEF_ACRONYMS = frozenset({"coo", "cfo", "cto", "cio", "cco", "chro"})
PROCUREMENT_TITLE_PHRASES = ("procurement", "purchasing", "sourcing", "supplier", "suppliers", "vendor",
                             "vendors", "category manager")
# A "Buyer" without a PROCUREMENT_TITLE_PHRASES phrase buys merchandise for a
# product company: procurement, but last-resort priority.
BUYER_TITLE_WORDS = ("buyer", "buyers")
DEPARTMENT_HEAD_TITLE_PHRASES = ("vp", "vice president", "svp", "evp", "head", "director", "controller", "comptroller")
HR_TITLE_PHRASES = ("recruiter", "recruiting", "recruitment", "talent acquisition", "human resources", "hr",
                    "people partner")
HIRING_MANAGER_TITLE_PHRASES = ("manager", "supervisor", "team lead", "team leader")

# Company size from a headcount range ("51-200", "10001+"): its upper bound.
# Hunter's Domain Search does not return a headcount, so in practice every
# company is COMPANY_SIZE_DEFAULT until another source provides one.
COMPANY_SIZE_SMALL_MAX = 50
COMPANY_SIZE_MEDIUM_MAX = 500
COMPANY_SIZE_DEFAULT = "medium"

# Priority tiers: lower is better.
RANK_TIER_EXECUTIVE_SMALL = 0     # executive / owner of a small company
RANK_TIER_AREA_HEAD = 1           # department head of the vacancy's area
RANK_TIER_PROCUREMENT = 2         # procurement / supplier management (not a merchandise buyer)
RANK_TIER_FINANCE = 2             # finance head, for FINANCE_VACANCY_AREAS
RANK_TIER_AREA_MANAGER = 2        # hiring manager of the vacancy's area (area bonus)
RANK_TIER_EXECUTIVE_MEDIUM = 3
RANK_TIER_OTHER_HEAD = 4          # department head of another area
RANK_TIER_EXECUTIVE_LARGE = 5
RANK_TIER_LAST_RESORT = 6         # other hiring managers, HR, merchandise buyers
RANK_TIER_UNKNOWN_SENIOR = 7      # unknown title, senior/executive seniority
# Within a tier: seniority first (lower is better; anything else counts as null).
SENIORITY_RANK = {"executive": 0, "senior": 1, "junior": 2}
SENIORITY_RANK_DEFAULT = 3
SENIOR_SENIORITIES = ("senior", "executive")

# Confidence = provider confidence x factor of the email's verification
# status. invalid / disposable addresses are dropped; webmail and any status
# not listed count as "unknown"; no status at all is None.
CONFIDENCE_FACTOR_BY_VERIFICATION = {"valid": 1.0, "accept_all": 0.85, "unknown": 0.75, None: 0.6}
DROPPED_VERIFICATION_STATUSES = ("invalid", "disposable")
GENERIC_EMAIL_CONFIDENCE_CAP = 0.3
# Within a tier, after seniority and confidence (lower is better).
VERIFICATION_RANK = {"valid": 0, "accept_all": 1, "unknown": 2, None: 3}

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
