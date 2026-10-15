# NoonDalton AI Marketing Suite

Full-stack AI-powered marketing content platform. Generates books, proposals, marketing assets, and social posts using DeepSeek — with a WYSIWYG editor, CRM-lite, analytics dashboard, and an AI chat assistant.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend API | Python 3.12 + FastAPI |
| Database | Google Cloud Firestore |
| Auth | Keycloak (JWT RS256 via JWKS) |
| LLM | DeepSeek |
| File Storage | Supabase Storage |
| Async Jobs | Celery + Redis |
| Frontend | React 18 + Vite + Tailwind CSS + Zustand |
| Deploy | Google Cloud Run (API) + Docker (Frontend) |
| CI/CD | GitHub Actions |

---

## Project Structure

```
ND-Marketing-Suite/
├── backend/
│   ├── app/
│   │   ├── config.py              # Pydantic Settings (env vars)
│   │   ├── main.py                # FastAPI app + routers
│   │   ├── dependencies/
│   │   │   └── auth.py            # Keycloak JWT verification
│   │   ├── routers/               # One file per feature module
│   │   │   ├── books.py           # Books + Chapters CRUD + generation
│   │   │   ├── proposals.py       # Proposals CRUD + AI draft + export
│   │   │   ├── customers.py       # CRM-lite + CSV import
│   │   │   ├── assets.py          # Marketing assets generation
│   │   │   ├── templates.py       # Reusable content templates
│   │   │   ├── chat.py            # AI conversational assistant
│   │   │   ├── reports.py         # KPI reports + Excel export
│   │   │   ├── settings.py        # Org settings (CRM, LLM, social)
│   │   │   ├── analysis.py        # SEO / AI-detection / plagiarism
│   │   │   └── jobs.py            # Async job polling
│   │   ├── schemas/               # Pydantic request/response models
│   │   ├── services/
│   │   │   ├── firestore_service.py  # Async Firestore repos
│   │   │   ├── deepseek_service.py   # Shared LLM calls
│   │   │   └── storage_service.py   # Supabase Storage wrapper
│   │   └── workers/
│   │       ├── celery_app.py         # Celery config (3 queues)
│   │       └── tasks/
│   │           ├── content_tasks.py  # Chapter / proposal generation
│   │           └── asset_tasks.py    # One-pager, whitepaper, social, infographic
│   ├── requirements.txt
│   ├── .env.example
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── api/axios.js           # Axios instance + typed API helpers
│   │   ├── store/authStore.js     # Zustand auth state
│   │   ├── hooks/
│   │   │   ├── useAuth.js         # Keycloak + Zustand combined hook
│   │   │   └── useJobPolling.js   # Long-running job poller (2s interval)
│   │   ├── components/
│   │   │   ├── layout/            # Sidebar + Layout shell
│   │   │   └── ui/                # Button, Badge, Card, Input, Modal, TagInput, Spinner
│   │   └── pages/
│   │       ├── Dashboard.jsx
│   │       ├── books/             # BookList, BookWorkflow (stepper), BookEditor (TipTap)
│   │       ├── proposals/         # ProposalList
│   │       ├── customers/         # CustomerList + CSV import
│   │       ├── assets/            # AssetList + generate modal
│   │       ├── templates/         # TemplateList + variable substitution
│   │       ├── reports/           # KPI cards + Recharts
│   │       ├── settings/          # LLM model, CRM, social connections
│   │       └── chat/              # AI conversational assistant
│   ├── package.json
│   ├── vite.config.js
│   ├── tailwind.config.js
│   └── Dockerfile.dev
├── docker-compose.yml             # Local dev stack (API + worker + Flower + Redis + Keycloak + Frontend)
└── .github/workflows/
    ├── ci.yml                     # Lint + test on PR
    └── deploy.yml                 # Auto-deploy to Cloud Run on develop push
```

---

## Quick Start (Local Development)

### Prerequisites
- Docker + Docker Compose
- Node 20+
- Python 3.12+
- A Google Cloud project with Firestore enabled
- DeepSeek API key
- Supabase project (for storage)

### 1. Clone and configure environment

```bash
cp backend/.env.example backend/.env
# Fill in all values in backend/.env
```

Required environment variables:

```env
# App
APP_NAME=NoonDalton AI Marketing Suite
APP_ENV=development
APP_DEBUG=true
APP_SECRET_KEY=your-secret-key

# Keycloak
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=nd-marketing
KEYCLOAK_CLIENT_ID=nd-backend

# Google Cloud / Firestore
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
FIRESTORE_DATABASE=(default)

# DeepSeek
DEEPSEEK_API_KEY=your-deepseek-api-key

# Supabase Storageexit()
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
SUPABASE_STORAGE_BUCKET=nd-assets

# Redis / Celery
REDIS_URL=redis://localhost:6379/0
CELERY_BROKER_URL=redis://localhost:6379/0
CELERY_RESULT_BACKEND=redis://localhost:6379/1
```

### 2. Start with Docker Compose

```bash
docker compose up --build
```

Services started:
- **API**: http://localhost:8000 (FastAPI + Swagger at /docs)
- **Frontend**: http://localhost:5173 (Vite dev server)
- **Keycloak**: http://localhost:8080 (admin/admin)
- **Flower** (Celery monitor): http://localhost:5555
- **Redis**: localhost:6379

### 3. Configure Keycloak

1. Open http://localhost:8080/admin → login admin/admin
2. Create realm: `nd-marketing`
3. Create client: `nd-frontend` (public, redirect URI: `http://localhost:5173/*`)
4. Create client: `nd-backend` (confidential)
5. Create a test user with password

### 4. Run backend directly (without Docker)

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 5. Run Celery worker

```bash
cd backend
celery -A app.workers.celery_app worker --loglevel=info -Q default,llm,exports --concurrency=2
```

### 6. Run frontend

```bash
cd frontend
npm install
npm run dev
```

---

## API Reference

Full API documentation is available at `/docs` (Swagger UI) when running in development mode.

Key endpoint groups:

| Prefix | Description |
|---|---|
| `GET /api/v1/health` | Health check (used by the deployment platform) |
| `/api/v1/books` | Book concepts + chapters + AI generation |
| `/api/v1/proposals` | Commercial proposals + AI draft + PDF/DOCX export |
| `/api/v1/customers` | CRM-lite CRUD + CSV bulk import |
| `/api/v1/assets` | One-pagers, whitepapers, social posts, infographics |
| `/api/v1/templates` | Reusable prompt/content templates |
| `/api/v1/chat` | AI conversational assistant |
| `/api/v1/reports` | KPI overview + per-book stats + Excel export |
| `/api/v1/settings` | Org-level config (LLM model, CRM, social) |
| `/api/v1/analysis` | SEO scoring, AI-detection, originality check |
| `/api/v1/jobs/{id}` | Poll async job status and progress |

### Authentication

All `/api/v1/*` endpoints require a valid Keycloak JWT in the `Authorization: Bearer <token>` header.

### Async pattern

Long-running operations (content generation, exports) use an async job pattern:

```
POST /api/v1/books/{id}/chapters/generate
→ 202 { "job_id": "abc123" }

GET /api/v1/jobs/abc123
→ { "status": "processing", "progress": 45 }
→ { "status": "completed", "progress": 100, "result": {...} }
```

---

## Deployment (Google Cloud Run)

The GitHub Actions workflow in `.github/workflows/deploy.yml` automatically deploys to Cloud Run when you push to the `develop` branch.

### Manual deploy

```bash
# Build and push
docker build -t europe-west1-docker.pkg.dev/PROJECT_ID/nd-marketing/nd-marketing-api:latest ./backend
docker push europe-west1-docker.pkg.dev/PROJECT_ID/nd-marketing/nd-marketing-api:latest

# Deploy
gcloud run deploy nd-marketing-api \
  --image europe-west1-docker.pkg.dev/PROJECT_ID/nd-marketing/nd-marketing-api:latest \
  --region europe-west1 \
  --platform managed \
  --allow-unauthenticated
```

---

## Development Notes

### Adding a new feature module

1. Create `backend/app/schemas/myfeature.py` (Pydantic models)
2. Create `backend/app/routers/myfeature.py` (FastAPI router)
3. Register in `backend/app/main.py`
4. If async jobs needed: add tasks to `backend/app/workers/tasks/`
5. Create `frontend/src/api/axios.js` typed helper
6. Create `frontend/src/pages/myfeature/` page components
7. Add route in `frontend/src/App.jsx`
8. Add nav item in `frontend/src/components/layout/Sidebar.jsx`

### Firestore data model

```
books/{bookId}
  ├── title, description, status, userId, ...
  └── chapters/{chapterId}
        ├── title, content (HTML), orderIndex, status
        └── ...

proposals/{proposalId}
jobs/{jobId}
customers/{customerId}
templates/{templateId}
assets/{assetId}
settings/{userId}   ← keyed by user ID (one doc per org)
```

### LLM provider

The backend uses DeepSeek for LLM calls. Configure it with `DEEPSEEK_API_KEY`.

---

## License

Proprietary — NoonDalton © 2026

# MarketGen_AI

# Proyecto SaaS de automatización de marketing con React, FastAPI y PostgreSQL.
