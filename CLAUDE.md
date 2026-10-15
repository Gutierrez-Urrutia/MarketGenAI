# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MarketGen AI (NoonDalton AI Marketing Suite) — a full-stack platform that generates books, proposals,
marketing assets, and social posts using LLMs, with a WYSIWYG editor, CRM-lite, analytics, and an AI
chat assistant.

**The root `README.md` is stale** — it describes an earlier Keycloak-based architecture that no longer
matches the code (see Authentication below). Trust `backend/app/main.py` and `backend/app/config.py`
over the README.

## Commands

### Backend (from `backend/`)
```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000       # dev server, Swagger at /docs
celery -A app.workers.celery_app worker --loglevel=info -Q default,llm,exports --concurrency=2
pytest                                           # run all tests
pytest tests/test_books.py                       # single file
pytest tests/test_books.py::TestBooks::test_x -v # single test
```
`pytest.ini` sets `asyncio_mode = auto` and `testpaths = tests` — async tests need no extra markers.

### Frontend (from `frontend/`)
```bash
npm install
npm run dev       # Vite dev server, http://localhost:5173
npm run build
npm run lint      # eslint src --ext .js,.jsx
```

### Full stack
```bash
docker compose up --build
```
Starts `api`, `worker`, `flower` (Celery monitor, :5555), `redis`, `keycloak` (legacy, unused by current
auth — see below), and `frontend`.

## Architecture

### Backend: FastAPI + Firestore, not SQL
`backend/app/database.py` sets up a SQLAlchemy/Postgres engine with a **hardcoded local password** — it
is dead/unused. All real persistence goes through `app/services/firestore_service.py`, which wraps
async Firestore collections behind repo-style classes (`create`, `get_or_404`, `list_by_user`, plus
per-feature helpers like chapters and jobs). Every router talks to Firestore through this service, never
through `database.py`.

### Authentication is custom, not Keycloak
Despite `config.py` still carrying `keycloak_*` settings and the frontend having `keycloak.js`, the
active auth path is a **self-rolled Firestore-backed JWT system**:
- `app/services/auth_service.py` — PBKDF2 password hashing, HS256 JWT signing (`app_secret_key`),
  refresh-token hashing.
- `app/dependencies/auth.py` — `verify_token` decodes the JWT directly (not via JWKS), requires
  `typ == "access"`, and builds a `CurrentUser` with `roles` (default `["user"]`).
- `app/core/rbac.py` — role hierarchy (`admin` > `manager` > `user`) for `require_role(...)` guards.
- `app/routers/auth.py` / `oauth.py` handle login/refresh and Google/Microsoft OAuth.

**Ownership model**: most collections (`proposals`, `books`, `customers`, `templates`, `assets`, `jobs`)
store a `userId` field, and routers use `_assert_owner` / `_get_X_for_user`-style checks to scope data
per user. Docs created before this existed lack `userId` — see
`backend/scripts/migrations/backfill_user_id.py` for the one-off backfill (run from `backend/`, matches
users by `emailLower` or JWT `sub`).

### Real routers vs `*_mock.py` routers
Several features have both a real router and a `*_mock.py` counterpart (e.g. `social.py` /
`social_mock.py`, `books.py` / `books_mock.py`, `assets_mock.py`, `reports_mock.py`, etc.). `main.py`
registers both, in a deliberate order: the real router first so its routes win on overlapping paths,
then the mock as a fallback for platforms/features not yet fully implemented. See the comment above
`social_mock` registration in `main.py` before reordering — mock routers exist to unblock frontend work
on integrations that aren't wired up yet, not as leftover cruft.

### LLM providers
`app/services/deepseek_service.py` is the primary LLM client (OpenAI SDK pointed at DeepSeek's
`base_url`), model configurable via `deepseek_model` (default `deepseek-flash`). `gemini_*` settings
exist in config as a secondary/fallback provider — check call sites before assuming DeepSeek-only.

### Async jobs
Long-running generation/export work goes through Celery (`app/workers/celery_app.py`, 3 queues:
`default`, `llm`, `exports`) with a job-polling pattern: routers create a Firestore job doc, return
`job_id`, and the frontend polls `GET /api/v1/jobs/{id}` (`frontend/src/hooks/useJobPolling.js`, 2s
interval) until `status` is `completed`/`failed`. Celery is configured to fail fast on a dead broker
(`broker_connection_timeout=2`, `max_retries=1`) so a sync fallback can kick in — check task call sites
for that fallback before assuming Celery is always in the path.

### CORS
`config.py`'s `backend_cors_origins` plus `main.py`'s `allow_origin_regex=r"https://.*\.vercel\.app"` —
any Vercel preview/prod deployment is allowed by regex in addition to the explicit origin list.

### Rendering / document export
`app/rendering/` builds one-pagers, infographics, and styled HTML flowables (WeasyPrint/ReportLab/
python-docx) used by the `assets` and `reports` export endpoints.

### Frontend structure
- `src/api/` — per-feature axios helpers (`axios.js` holds the shared instance).
- `src/store/authStore.js` — Zustand auth state; `src/hooks/useAuth.js` composes it.
- `src/context/` — `ThemeContext`, `LanguageContext` (see `src/i18n/translations.js` for the
  translation table — add new UI strings there, not inline).
- `src/pages/<feature>/` — one directory per feature module, mirroring the backend router split.

### Adding a new feature module
1. `backend/app/schemas/<feature>.py` — Pydantic models.
2. `backend/app/routers/<feature>.py` — FastAPI router; register in `backend/app/main.py` (mind
   real-vs-mock ordering if a mock counterpart exists or will exist).
3. Async work → `backend/app/workers/tasks/`.
4. `frontend/src/api/<feature>Api.js` helper.
5. `frontend/src/pages/<feature>/` page components; route in `App.jsx`; nav item in
   `components/layout/Sidebar.jsx`.
