# NoonDalton AI Marketing Suite

Plataforma full-stack de contenido de marketing impulsada por IA. Genera libros, propuestas, activos de marketing y publicaciones para redes sociales usando DeepSeek — con un editor WYSIWYG, un CRM-lite, un panel de analítica y un asistente de chat con IA.

---

## Stack Tecnológico

| Capa | Tecnología |
|---|---|
| Backend API | Python 3.12 + FastAPI |
| Base de datos | Google Cloud Firestore |
| Auth | JWT propio (HS256) sobre Firestore — ver nota en [Autenticación](#autenticación) |
| LLM | DeepSeek |
| Almacenamiento de archivos | Supabase Storage |
| Trabajos asíncronos | Celery + Redis |
| Frontend | React 18 + Vite + Tailwind CSS + Zustand |
| Despliegue | Google Cloud Run (API) + Docker (Frontend) |
| CI/CD | GitHub Actions |

---

## Estructura del Proyecto

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

## Inicio Rápido (Desarrollo Local)

### Prerrequisitos
- Docker + Docker Compose
- Node 20+
- Python 3.12+
- Un proyecto de Google Cloud con Firestore habilitado
- Clave de API de DeepSeek
- Proyecto de Supabase (para almacenamiento)

### 1. Clonar y configurar el entorno

```bash
cp backend/.env.example backend/.env
# Fill in all values in backend/.env
```

Variables de entorno requeridas:

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

# Supabase Storage
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
SUPABASE_STORAGE_BUCKET=nd-assets

# Redis / Celery
REDIS_URL=redis://localhost:6379/0
CELERY_BROKER_URL=redis://localhost:6379/0
CELERY_RESULT_BACKEND=redis://localhost:6379/1

# Pipeline de prospección (Fase 1)
PIPELINE_ENCRYPTION_KEY=replace-with-a-generated-fernet-key
```

> **Nota sobre `PIPELINE_ENCRYPTION_KEY`:** esta clave es específica de cada entorno — no reutilices la de desarrollo en producción. Genera una nueva con:
> ```bash
> python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
> ```
> En producción, configúrala como variable de entorno en la plataforma de despliegue (no la subas al repo). Si se pierde la clave, las contraseñas SMTP cifradas con ella quedan irrecuperables y hay que volver a ingresarlas desde la pestaña Pipeline. Sin esta variable configurada, `PUT /api/v1/pipeline/config` responde `503` al intentar guardar credenciales SMTP.

### 2. Iniciar con Docker Compose

```bash
docker compose up --build
```

Servicios iniciados:
- **API**: http://localhost:8000 (FastAPI + Swagger en /docs)
- **Frontend**: http://localhost:5173 (servidor de desarrollo Vite)
- **Keycloak**: http://localhost:8080 (admin/admin)
- **Flower** (monitor de Celery): http://localhost:5555
- **Redis**: localhost:6379

### 3. Configurar Keycloak (legado, opcional)

> **Nota:** el servicio `keycloak` sigue presente en `docker-compose.yml` y las variables `KEYCLOAK_*` siguen en `backend/app/config.py`, pero no participan del flujo de autenticación real (ver [Autenticación](#autenticación)). Este paso es opcional y solo aplica si estás trabajando en esa parte legada del proyecto.

1. Abrir http://localhost:8080/admin → iniciar sesión con admin/admin
2. Crear realm: `nd-marketing`
3. Crear cliente: `nd-frontend` (público, redirect URI: `http://localhost:5173/*`)
4. Crear cliente: `nd-backend` (confidencial)
5. Crear un usuario de prueba con contraseña

### 4. Ejecutar el backend directamente (sin Docker)

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 5. Ejecutar el worker de Celery

```bash
cd backend
celery -A app.workers.celery_app worker --loglevel=info -Q default,llm,exports --concurrency=2
```

### 6. Ejecutar el frontend

```bash
cd frontend
npm install
npm run dev
```

---

## Referencia de la API

La documentación completa de la API está disponible en `/docs` (Swagger UI) al ejecutar en modo desarrollo.

Grupos de endpoints principales:

| Prefijo | Descripción |
|---|---|
| `GET /api/v1/health` | Health check (usado por la plataforma de despliegue) |
| `/api/v1/books` | Conceptos de libros + capítulos + generación con IA |
| `/api/v1/proposals` | Propuestas comerciales + borrador con IA + exportación PDF/DOCX |
| `/api/v1/customers` | CRUD del CRM-lite + importación masiva por CSV |
| `/api/v1/assets` | One-pagers, whitepapers, publicaciones sociales, infografías |
| `/api/v1/templates` | Plantillas reutilizables de prompt/contenido |
| `/api/v1/chat` | Asistente de chat con IA |
| `/api/v1/reports` | Resumen de KPI + estadísticas por libro + exportación a Excel |
| `/api/v1/settings` | Configuración a nivel de organización (modelo LLM, CRM, redes sociales) |
| `/api/v1/analysis` | Puntaje SEO, detección de IA, verificación de originalidad |
| `/api/v1/jobs/{id}` | Consultar el estado y progreso de un trabajo asíncrono |

### Autenticación

Todos los endpoints `/api/v1/*` requieren un JWT válido en el encabezado `Authorization: Bearer <token>`. La autenticación real es un sistema propio respaldado en Firestore: `backend/app/services/auth_service.py` firma los tokens de acceso con HS256 (`APP_SECRET_KEY`) y `backend/app/dependencies/auth.py` los valida decodificándolos directamente, sin pasar por Keycloak/JWKS.

> **Nota:** Keycloak sigue configurado en `docker-compose.yml` y en `backend/app/config.py` (variables `KEYCLOAK_*`), pero es infraestructura legada que no interviene en este flujo de autenticación.

### Patrón asíncrono

Las operaciones de larga duración (generación de contenido, exportaciones) usan un patrón de trabajo asíncrono:

```
POST /api/v1/books/{id}/chapters/generate
→ 202 { "job_id": "abc123" }

GET /api/v1/jobs/abc123
→ { "status": "processing", "progress": 45 }
→ { "status": "completed", "progress": 100, "result": {...} }
```

---

## Despliegue (Vercel)

La plataforma de despliegue es **Vercel** (confirmado en la documentación del proyecto — criterios de aceptación y Contexto y Alcance — y consistente con la evidencia en el repo). El backend corre como función serverless, no como contenedor de larga duración:

- `api/index.py`: entrypoint serverless de Vercel — agrega `backend/` al `sys.path` e importa `app.main.app`. Su docstring lo dice explícitamente: `"""Vercel serverless entrypoint for the FastAPI backend."""`.
- `requirements.txt` en la raíz del repo (no solo en `backend/requirements.txt`): contiene `-r backend/requirements.txt` — es la convención que usa Vercel para detectar el runtime de Python del proyecto.
- `.vercelignore` en la raíz: archivo de configuración exclusivo de Vercel (excluye `node_modules`, `frontend/dist`, credenciales, etc. del despliegue).
- `backend/app/main.py`: el CORS habilita explícitamente `allow_origin_regex=r"https://.*\.vercel\.app"`, es decir, cualquier preview o producción de Vercel.
- Base de datos: Firestore, región `southamerica-west1` (según Contexto y Alcance del proyecto).

No hay un `vercel.json` versionado en el repo, así que la configuración del proyecto en Vercel probablemente vive en su dashboard (conectado directamente al repositorio de Git), no en un archivo de configuración versionado. Tampoco hay ningún workflow de CI/CD en el repo — no existe `.github/workflows/` — por lo que el despliegue a Vercel ocurre automáticamente vía la integración nativa de Vercel con Git al hacer push, no mediante un pipeline propio.

---

## Notas de Desarrollo

### Agregar un nuevo módulo de funcionalidad

1. Crear `backend/app/schemas/myfeature.py` (modelos Pydantic)
2. Crear `backend/app/routers/myfeature.py` (router FastAPI)
3. Registrar en `backend/app/main.py`
4. Si se necesitan trabajos asíncronos: agregar tasks a `backend/app/workers/tasks/`
5. Crear el helper tipado `frontend/src/api/axios.js`
6. Crear los componentes de página en `frontend/src/pages/myfeature/`
7. Agregar la ruta en `frontend/src/App.jsx`
8. Agregar el ítem de navegación en `frontend/src/components/layout/Sidebar.jsx`

### Modelo de datos de Firestore

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

### Proveedor de LLM

El backend usa DeepSeek para las llamadas al LLM. Configúralo con `DEEPSEEK_API_KEY`.

### Pipeline de prospección de 3 agentes

Hay un pipeline de prospección en desarrollo (Agente 1: Job Scout, Agente 2: Lead Researcher, Agente 3: Email Composer). Lo que existe hoy en el código es solo la **Fase 1 (infraestructura)**:

- `backend/app/routers/pipeline.py` + `backend/app/schemas/pipeline.py`: CRUD de `PipelineConfig` (un documento por usuario en Firestore, colección `pipeline_configs`).
- Configuración de fuentes (`JobSource`): tipos `api`, `rss`, `scraper` y `webhook`, cada uno con sus campos de configuración requeridos — sin llamadas externas todavía (eso corresponde a una fase posterior).
- Credenciales SMTP cifradas: `smtp_password` se cifra con Fernet (`backend/app/services/encryption_service.py`, variable `PIPELINE_ENCRYPTION_KEY`) antes de guardarse como `smtp_password_encrypted`; la API nunca devuelve la contraseña, solo un booleano `smtp_password_configured`.

Los Agentes 1/2/3, el orquestador, los endpoints de `leads`/`contacts`/`outreach_emails` y el escaneo programado **no están implementados aún** — están planificados en `plan-pipeline-3-agentes.md` (raíz del repo), fases 2 a 6.

---

## Licencia

Propietario — NoonDalton © 2026
