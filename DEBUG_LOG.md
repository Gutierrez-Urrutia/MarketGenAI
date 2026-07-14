# Debug Log — MarketGen AI

Debugging documentation (deliverable for the project defense, 10/Jul/2026).
Each entry: **Date · Problem · Root Cause · Solution · Lesson**.

---

## 2026-06-10 (20:45) — Routers without authentication / without `userId` filtering (P0)

**Problem:** Several backend endpoints did not require `Depends(get_current_user)` and/or did not filter results by `userId`, exposing data across users or allowing anonymous access:
- `platform.py`: `/activity` and `/search`.
- `reports.py`: `/dashboard`.
- `assistant.py`: `/chat`.
- `social_mock.py`: `connect`/`disconnect`.

In addition, `config.py` allowed the app to start with `APP_ENV=production` while `APP_SECRET_KEY` was still set to `change-me-in-production`.

**Root cause:** These endpoints were written before the ownership pattern (`_assert_owner` / `_get_X_for_user`, rule 2 of CLAUDE.md) was adopted — a pattern that was applied to `books.py` / `proposals.py` — and were never retrofitted to the rest of the routers. `config.py` also did not validate the secret key in production.

**Solution** (commit `edd99b6`):
- `platform.py`: `/activity` and `/search` now receive `user: CurrentUser = Depends(get_current_user)` and filter by `[("userId", "==", user.sub)]` (public templates with `isPublic=true` are added on top of the user's own).
- `reports.py`: `/dashboard` counts/lists only `books`/`proposals`/`customers` belonging to the authenticated user.
- `assistant.py`: `/chat` now requires `Depends(get_current_user)` (no `userId` filter, since it is a stateless chat endpoint).
- `social_mock.py`: `connect`/`disconnect` now require `Depends(get_current_user)`.
- `config.py`: new `model_validator` that raises `RuntimeError` if `APP_ENV=production` and `APP_SECRET_KEY` is still the default value.
- New test coverage: `backend/tests/test_smoke_security_fix.py`.

**Lesson:** The fact that the ownership pattern exists in one reference router does not mean it has been propagated everywhere. Auditing **every** router registered in `main.py` (grep for `@router.(get|post|put|delete)` without a nearby `Depends(get_current_user)`) catches these gaps before they reach production.

---

## 2026-06-10 (21:50) — `userId` backfill for orphaned documents

**Problem:** After the previous fix (filtering by `userId == user.sub`), Firestore documents created **before** that filter existed in `proposals`, `books`, `customers`, `templates`, `assets` and `jobs` had no `userId` field. `_assert_owner` / `_get_X_for_user` rejected them with a 403 even though they belonged to their rightful owner.

**Root cause:** The `userId` field only started being written to these collections as part of the security fix in the previous entry; pre-existing documents were left "orphaned", and the new ownership filter excludes them by design.

**Solution** (commit `e2dbade`): script `backend/scripts/migrations/backfill_user_id.py` + `README.md`:
- Dry-run by default: counts and lists documents without `userId` per collection, without writing anything.
- `--apply` (+ `yes` confirmation) assigns `userId` ONLY to documents missing that field; never overwrites or deletes.
- Resolves the `userId` via `--email` (looks up `users` by `emailLower`) or a direct `--user-id <sub>`.
- Excludes `books/{id}/chapters` (inherit ownership from the parent book) and `settings/{userId}` (the doc id is already the `userId`); by default skips `templates` with `isPublic=true`.
- Result: run against the real database, 0 orphaned documents remaining in the target collections.

**Lesson:** Any change that adds a mandatory ownership field to existing collections needs a **non-destructive** backfill script (dry-run by default, never overwrite) before deployment — otherwise the security fix breaks real users' access to their own historical content.

---

## 2026-06-10 (22:32) — camelCase/snake_case mismatch in login and refresh contracts

**Problem:** The frontend (`api/axios.js`) sends `{ usernameOrEmail, password }` to `POST /auth/login` and `{ refreshToken }` to `POST /auth/refresh`, but the Pydantic schemas expected `email: EmailStr` and `refresh_token: str` (snake_case) → 422 errors on login and on the interceptor's automatic refresh.

**Root cause:** `backend/app/schemas/auth.py` was defined using the typical Pydantic/Python snake_case convention, without aligning field names with the camelCase body sent by axios (Pydantic does not automatically convert between snake_case and camelCase unless an explicit alias is set).

**Solution** (commit `175dcb4`):
- `LoginRequest.email: EmailStr` → `LoginRequest.usernameOrEmail: EmailStr`.
- `RefreshRequest.refresh_token: str` → `RefreshRequest.refreshToken: str`.
- `routers/auth.py` updated to read `body.usernameOrEmail` / `body.refreshToken`.
- New contract tests: `backend/tests/test_login_contract.py`, `backend/tests/test_refresh_contract.py`.

**Lesson:** Pydantic schemas for endpoints consumed directly by the frontend must be named in camelCase (or use `Field(alias=...)`) to match the real request body. Cover every auth endpoint with a dedicated contract test, not just manual testing — this kind of mismatch is not caught by FastAPI's internal typing, only by an actual call.

---

## 2026-06-11 — Dead tree: unrouted `pages/*` and `components/ui/*` vs. the `Dashboard.jsx` monolith

**Problem:** `CLAUDE.md` stated "reuse components from `components/ui/`" as if that were the active UI foundation of the frontend. Most of `frontend/src/pages/` and `frontend/src/components/ui/` (along with `components/layout/`) is never rendered in the real app.

**Root cause:** `main.jsx` mounts `<App/>` inside `BrowserRouter`, but `App.jsx` does not define any `<Routes>`: it manually decides between `LoginScreen` / `ResetPasswordScreen` / `Dashboard` based on `window.location.pathname`, and imports `Dashboard` from `./Dashboard` (a file at the root of `src/`), not from `pages/Dashboard.jsx`. That root-level `Dashboard.jsx` defines its own inline UI primitives (`Btn`, `Card`, `Field`, `Input`, `Select`, `Badge`, `ReportsPage`, `SettingsPage`, etc.). `pages/*`, `components/layout/*` and most of `components/ui/*` correspond to a modularization attempt (with its own `pages/Dashboard.jsx`, `Sidebar`, `Layout`) that was never wired to the real entrypoint.

**Solution:**
- Traced the real import tree starting from `main.jsx`: the **only** part of `pages/*`/`components/ui/*` that is actually live is `pages/chat/Chat.jsx` (imported by `Dashboard.jsx`, line 32) along with its two dependencies `components/ui/Button.jsx` and `components/ui/Spinner.jsx`. Everything else (`pages/Dashboard.jsx`, `pages/books/*`, `pages/proposals/*`, `pages/customers/*`, `pages/templates/*`, `pages/reports/*`, `pages/settings/*`, `pages/assets/*`, `components/layout/Layout.jsx`, `components/layout/Sidebar.jsx`, and the rest of `components/ui/*`) has no importer reachable from `main.jsx`.
- `CLAUDE.md` rule 5 updated: use `Dashboard.jsx`'s local primitives for new UI; do not import from `pages/*`/`components/ui/*` except for the confirmed exception of `Chat.jsx` + `Button`/`Spinner`.

**Lesson:** Before documenting "where reusable UI lives," trace the real import tree from the entrypoint (`main.jsx`) — don't assume it based on folder naming conventions (`pages/`, `components/ui/`). A project can have two parallel implementations (modular vs. monolith) where only one is actually wired up — and naming conventions won't reveal which.

**Pending / to decide:**
- Confirm whether `pages/*` (except `chat/`), `components/layout/`, and the rest of `components/ui/` should be removed or kept as reference for a future migration to real routing.
- Re-evaluate CLAUDE.md "Next tasks" item #4 (Sidebar i18n): `components/layout/Sidebar.jsx` is not rendered; the real sidebar is inline in `Dashboard.jsx`.

---

## 2026-07-09 — Partial synchronous fallback for content generation (Celery/Redis vs. Vercel serverless)

**Problem:** Content generation was originally designed to run asynchronously via Celery workers backed by Redis (`backend/app/workers/celery_app.py`, `workers/tasks/content_tasks.py`, `workers/tasks/asset_tasks.py`), dispatched from routers with `task_X.delay(...)`. This model assumes a long-running worker process that stays connected to a Redis broker — which the target deployment does not provide: the backend runs as Vercel serverless functions (`api/index.py` → `backend/app/main.py`), with no persistent process to host a Celery worker and no bundled Redis broker. `.env.example` still points `REDIS_URL`/`CELERY_BROKER_URL`/`CELERY_RESULT_BACKEND` at `redis://localhost:6379`, which is unreachable in production.

**Root cause:** The async task-queue architecture was designed before the deployment target moved to Vercel serverless (see also the earlier Render → Vercel migration noted in `CLAUDE.md`). Nobody had removed or fully replaced the Celery-based flows to match the new runtime constraints, so most generation endpoints still call `.delay()` against a broker that isn't reachable.

**Solution (partial — not applied uniformly):**
- **Whitepaper generation** (`routers/assets.py:137-157`) was fully converted: it now calls `await generate_whitepaper_now(...)` directly instead of dispatching a Celery task. That shared function lives in `workers/tasks/asset_tasks.py:251-294` and is reused by both the (now unused in this path) Celery task and the sync call. It also switched PDF rendering from WeasyPrint to ReportLab, since WeasyPrint requires native GTK/Pango system libraries unavailable on Vercel.
- **Chapter generation** (`routers/books.py:377-386`, `_generate_chapters_now` at line 96) and **all-content generation** (`routers/books.py:577-594`, `_generate_all_content_now` at line 124) got an **opt-in** sync path via a new `sync: bool = False` field on the request schemas (`schemas/book.py:146,155`). All-content generation additionally wraps `task_generate_all_content.delay(...)` in a `try/except` that falls back to the synchronous implementation if dispatch fails (`books.py:585-593`, comment: `# Redis/Celery no disponible — ejecutar síncronamente`).
- `celery_app.py:50-52` was tuned for fast failure (`broker_connection_timeout=2`, `broker_connection_max_retries=1`, comment: *"so the sync fallback kicks in quickly"*), indicating the fallback pattern was intended to be applied broadly.
- **Not migrated** — still 100% dependent on `.delay()` with no fallback, and therefore likely non-functional in production unless an external Celery worker + managed Redis instance exists (no evidence of one in this repo): one-pager generation (`assets.py:132`), social posts generation (`assets.py:177`), infographic generation (`assets.py:194`), single-chapter regeneration (`books.py:630`), and book publishing/translation (`publishing.py:148,185`).

**Lesson:** A change of deployment target (worker-based → serverless) invalidates any architecture that assumes a persistent background process, even if the code that dispatches to it still "compiles" and looks correct. Partial migrations are dangerous precisely because they're inconsistent in a way that isn't visible from any single file — a router that still calls `.delay()` looks identical whether or not a worker is listening on the other end. Before closing out this kind of migration, grep for every `.delay(`/`apply_async(` call site and confirm each either has a working broker in production or an equivalent sync fallback.

**Pending / to decide:**
- Apply the same sync-fallback pattern (or the `try/except` variant used in `generate_all_content`) to one-pager, social posts, infographic, single-chapter, publish, and translate flows — or confirm a managed Redis + external worker is actually provisioned for production and this is a non-issue.
- Decide whether `sync` should default to `True` for serverless deployments instead of being opt-in, given `.delay()` alone is not safe there.
