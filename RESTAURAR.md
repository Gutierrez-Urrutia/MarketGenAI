# Restaurar el proyecto tras formatear la máquina

Guía para dejar MarketGen AI funcionando de nuevo en una máquina limpia. Sigue el orden.

## 1. Qué instalar

| Herramienta | Versión | Motivo |
|---|---|---|
| Git | 2.49.x o superior | control de versiones |
| Python | **3.12** | `backend/Dockerfile` usa `python:3.12-slim` para build y runtime; usar esa misma versión fuera de Docker evita sorpresas de compatibilidad con `cryptography==50.0.1`, `pydantic==2.10.2`, etc. |
| Node.js | 20.x LTS o superior (probado con 24.14.1) | frontend Vite/React 18. No hay `engines` fijado en `frontend/package.json`, cualquier LTS reciente sirve |
| npm | la que venga con el Node instalado | gestor de paquetes del frontend |
| Redis | opcional en local (docker-compose lo levanta) | broker de Celery; sin él, el backend sigue funcionando con el respaldo síncrono (`fix(pipeline): stop task.delay() from freezing the event loop when Redis is down`) pero sin cola de trabajos real |
| Docker + Docker Compose | opcional | alternativa a instalar Python/Node a mano — `docker compose up --build` levanta api, worker, flower, redis y frontend |

No hace falta instalar Keycloak: es legado, no se usa (ver `CLAUDE.md`).

## 2. Archivos a restaurar a mano (no están en el repositorio)

Ninguno de estos archivos se sube a git (`.gitignore` los excluye). Recupéralos desde tu backup propio (gestor de contraseñas, backup cifrado, etc.) — **no hay valores reales en este repositorio**, solo se listan los nombres de las variables que debe contener cada archivo.

### `backend/.env`

```
APP_NAME, APP_ENV, APP_DEBUG, APP_SECRET_KEY
ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS, PASSWORD_RESET_TOKEN_EXPIRE_MINUTES
LOCAL_DEV_AUTH_ENABLED, LOCAL_DEV_AUTH_EMAIL, LOCAL_DEV_AUTH_PASSWORD, LOCAL_DEV_AUTH_NAME
BACKEND_CORS_ORIGINS
GOOGLE_CLOUD_PROJECT, GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_CREDENTIALS_PATH, FIRESTORE_DATABASE
GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_REDIRECT_URI
FRONTEND_URL
META_APP_ID, META_APP_SECRET, META_REDIRECT_URI, META_GRAPH_API_VERSION, META_ACCESS_TOKEN
LINKEDIN_ACCESS_TOKEN
TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET, TWITTER_API_KEY, TWITTER_API_SECRET
GEMINI_API_KEY, GOOGLE_API_KEY, GEMINI_DEFAULT_MODEL, GEMINI_MAX_TOKENS, GEMINI_TEMPERATURE
DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL
SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_STORAGE_BUCKET
REDIS_URL, CELERY_BROKER_URL, CELERY_RESULT_BACKEND
PIPELINE_ENCRYPTION_KEY
```

Hay una plantilla con el formato y comentarios de cada bloque en `backend/.env.example` — cópiala a `backend/.env` y rellena los valores reales desde tu backup.

### `backend/service-account.json`

Credencial de servicio de Google Cloud (Firestore), formato JSON estándar de *service account key* (`type`, `project_id`, `private_key`, `client_email`, etc.). `GOOGLE_APPLICATION_CREDENTIALS` y `FIREBASE_CREDENTIALS_PATH` en `.env` deben apuntar a la ruta absoluta de este archivo.

## 3. Advertencia importante: `PIPELINE_ENCRYPTION_KEY`

**Esta clave no se puede regenerar.** Es una clave Fernet simétrica que cifra las contraseñas SMTP y las API keys de proveedores del pipeline de prospección antes de guardarlas en Firestore (`backend/app/services/encryption_service.py`). Si se pierde:

- Todo lo que ya está cifrado en Firestore con la clave anterior queda **ilegible para siempre** (no hay forma de descifrarlo sin la clave original).
- Habría que volver a introducir manualmente cada contraseña SMTP y cada API key guardada en el pipeline.

Restaura el mismo valor que tenías, no generes uno nuevo. Si de verdad se perdió, genera uno nuevo solo como último recurso (`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`) y vuelve a cargar manualmente las credenciales del pipeline desde cero.

## 4. Levantar backend y frontend

### Opción A — Docker (más simple)

```bash
docker compose up --build
```

Levanta `api` (puerto 8000), `worker`, `flower` (puerto 5555), `redis` y `frontend`. Requiere `backend/.env` ya restaurado (se monta con `env_file`).

### Opción B — Manual

Backend, desde `backend/`:
```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Worker de Celery (opcional, en otra terminal):
```bash
celery -A app.workers.celery_app worker --loglevel=info -Q default,llm,exports --concurrency=2
```

Frontend, desde `frontend/`:
```bash
npm install
npm run dev
```

### Verificar que quedó funcionando

1. Backend: abrir `http://localhost:8000/docs` (Swagger) — debe cargar sin error de conexión a Firestore.
2. Correr la suite de tests del backend: `pytest` desde `backend/` — debería dar el mismo resultado que en `PR-fase1.md` (179 passed) salvo por deuda técnica preexistente ya documentada ahí.
3. Frontend: abrir `http://localhost:5173`, iniciar sesión (con `LOCAL_DEV_AUTH_*` si está habilitado) y confirmar que carga el Dashboard.
4. Ir a Configuración → pestaña Pipeline y confirmar que la configuración guardada antes de formatear sigue ahí y que se puede guardar sin el error 503 de `PIPELINE_ENCRYPTION_KEY` faltante.

## 5. En qué punto quedó el trabajo

- **Punto 4 pendiente**: separador por fuente, validación de título, script de corrección en simulación.
- Pendientes adicionales anotados en [`PR-fase1.md`](PR-fase1.md):
  - Sección "Deuda técnica (fuera de alcance de este PR)".
  - Sección "Pendiente de decisión del equipo: CORS demasiado amplio" (`allow_credentials=True` combinado con el regex `*.vercel.app`).
  - Sección "Tarea aparte: dependencias vulnerables" (hallazgos de `pip-audit` y `npm audit`).
  - Sección "Pendientes (no corregidos)" al final del documento (presupuesto de tiempo no chequeado dentro del bucle de lotes, revacunas repetidas de leads bajo el umbral, mismo patrón de `.delay()` síncrono sin corregir en `books.py`/`publishing.py`, pruebas con Celery real sin hacer, ventana residual de doble ejecución).

Revisa ese archivo completo al retomar el trabajo — tiene el detalle y el contexto de cada punto.
