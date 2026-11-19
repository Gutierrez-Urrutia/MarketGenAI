# Manual de despliegue — MarketGen AI (NoonDalton AI Marketing Suite)

Cubre RNF-05, criterio 2: dependencias, variables de entorno y pasos para levantar la aplicación en local y en la nube.
Si algo de aquí contradice al `README.md` raíz, vale este manual (el README describe una arquitectura anterior con Keycloak).

## 1. Qué se despliega

| Pieza | Tecnología | Dónde corre en dev |
|---|---|---|
| API | FastAPI (Python 3.12) | Cloud Run `marketgen-api` (`ROLE=api`) |
| Web | React 18 + Vite, servida por nginx | Cloud Run `marketgen-web` |
| Worker | Celery + Redis | VM `marketgen-worker` (se enciende solo cuando se necesita) |
| Base de datos | Firestore | `marketgen-dev` (`nam5`) |
| Archivos generados | Cloud Storage (URLs firmadas) | bucket `marketgen-dev-assets` |
| Secretos | Secret Manager | `marketgen-dev` |
| IA | DeepSeek (API externa) | — |

## 2. Dependencias

**Para trabajar en local**

| Herramienta | Versión | Para qué |
|---|---|---|
| Python | 3.12 | Backend |
| Node.js | 22 | Frontend |
| Git | cualquiera | Código |
| Docker | cualquiera | Redis local (opcional) y construir imágenes |
| Redis | 7 | Cola de Celery (opcional; ver §4) |
| Librerías de sistema (solo Linux/CI) | `libpango-1.0-0 libpangoft2-1.0-0 libgdk-pixbuf-2.0-0` | WeasyPrint (PDF) |

**Para desplegar en la nube:** Google Cloud SDK (`gcloud`) con una cuenta con permisos sobre `marketgen-dev`.
En Windows, `gcloud.cmd` rompe argumentos con paréntesis o `|`: usar el Python que trae el SDK
(`platform\bundledpython\python.exe lib\gcloud.py`) o definir `GCLOUD` con la ruta a `gcloud.cmd` para los scripts de `infra/gcp/`.

Las dependencias de Python están fijadas en `backend/requirements.txt` y las de Node en `frontend/package-lock.json`.

**Servicios externos que necesita:** DeepSeek (llave de API), Google OAuth (cliente OAuth, opcional si solo se usa correo y contraseña),
Microsoft Entra ID (opcional: login con Microsoft y buzón de envío), HubSpot o Salesforce (opcional, para enviar propuestas al CRM).

## 3. Variables de entorno

Se leen de `backend/.env` en local (plantilla: `backend/.env.example`) y de Cloud Run + Secret Manager en la nube.
**Nunca** se suben al repositorio: `.env` está ignorado por git.

### Backend — obligatorias

| Variable | Descripción | En la nube |
|---|---|---|
| `APP_ENV` | `development` o `production`. En `production` se exige una clave segura y se ocultan `/docs`, `/redoc` y `/openapi.json` | variable |
| `APP_SECRET_KEY` | Firma de los JWT. Larga y aleatoria | **secreto** `app-secret-key` |
| `GOOGLE_CLOUD_PROJECT` | Proyecto de Firestore (`marketgen-dev`) | variable |
| Credenciales de Firestore | En local: `GOOGLE_APPLICATION_CREDENTIALS` (ruta a JSON), `FIREBASE_CREDENTIALS_PATH` o `FIREBASE_SERVICE_ACCOUNT_JSON`. En la nube se usa la cuenta de servicio del servicio, sin archivo | — |
| `DEEPSEEK_API_KEY` | Llave de la IA | **secreto** `deepseek-api-key` |
| `PIPELINE_ENCRYPTION_KEY` | Llave Fernet que cifra las llaves de proveedores y tokens del buzón. **Local y dev comparten el mismo Firestore, así que deben usar la MISMA llave** (ver §7). Para local, copiar el valor del secreto de dev (`gcloud secrets versions access latest --secret=pipeline-encryption-key`) en `backend/.env`. Generar con `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` | **secreto** `pipeline-encryption-key` |
| `BACKEND_CORS_ORIGINS` | Orígenes permitidos, separados por coma (la URL de la web) | variable |
| `FRONTEND_URL` | URL de la web (redirecciones del login con Google) | variable |

### Backend — según la funcionalidad

| Variable | Descripción | Valor habitual |
|---|---|---|
| `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` | Endpoint y modelo | `https://api.deepseek.com`, `deepseek-flash` |
| `LLM_DEFAULT_TIMEOUT_SECONDS` | Tiempo máximo de cada llamada a la IA (vacío = sin límite) | vacío |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Login con Google | secreto `google-oauth-client-secret` |
| `MAIL_GOOGLE_REDIRECT_URL` | Redirección para conectar el Gmail del usuario (enviar correos). Misma app de Google que el login; registrar esta URI exacta en el cliente OAuth (ver §5.6) | local `http://127.0.0.1:8000/api/v1/mail-connection/google/callback`; dev: URL de Cloud Run + `/api/v1/mail-connection/google/callback` |
| `GOOGLE_REDIRECT_URI` | Debe coincidir **exacta** con la URI registrada en el cliente OAuth | local `http://127.0.0.1:8000/api/v1/auth/google/callback`; dev: URL de Cloud Run + `/api/v1/auth/google/callback` |
| `STORAGE_BACKEND`, `GCS_BUCKET` | `gcs` y el bucket para guardar los archivos generados | `gcs`, `marketgen-dev-assets` |
| `REDIS_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND` | Cola de tareas largas | `redis://localhost:6379/0` y `/1` en local; secretos en la nube |
| `ROLE` | Qué proceso corre el contenedor: `all`, `api` o `worker` | `api` (Cloud Run), `worker` (VM) |
| `ACCESS_TOKEN_EXPIRE_MINUTES`, `REFRESH_TOKEN_EXPIRE_DAYS` | Duración de las sesiones | 30 y 14 |
| `LOCAL_DEV_AUTH_ENABLED`, `LOCAL_DEV_AUTH_EMAIL`, `LOCAL_DEV_AUTH_PASSWORD` | Cuenta de desarrollo. En la nube la contraseña es el secreto `local-dev-auth-password`; desactivar en producción real | — |
| `RATE_LIMIT_ENABLED`, `AUDIT_LOG_ENABLED` | Límite de frecuencia y registro de auditoría | `true` |
| `MICROSOFT_OAUTH_*`, `MAIL_OAUTH_*` | Login con Microsoft y envío desde Outlook / Microsoft 365 (registro de app propio en Entra ID) | ver `.env.example` |
| `OUTREACH_REAL_SEND_ENABLED` | Interruptor general del envío real de correos de prospección, con Outlook o Gmail (apagado por defecto; además cada usuario lo enciende en Configuración) | `false` |
| `META_*`, `LINKEDIN_ACCESS_TOKEN`, `TWITTER_*` | Publicación en redes sociales (integraciones parciales) | opcional |

Obsoletas (se pueden dejar vacías): `SUPABASE_*` (el proyecto configurado ya no existe), `GEMINI_*`/`GOOGLE_API_KEY` (proveedor de respaldo no usado), `VITE_KEYCLOAK_*`.

### Frontend

| Variable | Descripción |
|---|---|
| `VITE_API_URL` | URL base de la API, p. ej. `http://127.0.0.1:8000/api/v1`. **Se fija al compilar**: cambiarla exige reconstruir la imagen |
| `VITE_ENABLE_DEMO_LOGIN`, `VITE_SHOW_DEMO_BANNER` | Acceso y aviso de demostración |

## 4. Ejecución en local

```bash
# Backend (desde backend/)
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # en Linux/Mac: .venv/bin/pip
cp .env.example .env                                # completar las variables obligatorias (§3)
.venv/Scripts/python -m uvicorn app.main:app --port 8000
# Documentación interactiva: http://127.0.0.1:8000/docs  (solo con APP_ENV=development)

# Frontend (desde frontend/)
npm install
npm run dev                                         # http://localhost:5173
```

- Entrar por `127.0.0.1` y no por `localhost` si se usa Google: esa es la URI registrada.
- **Redis y el worker son opcionales.** Sin ellos, la generación de propuestas corre dentro de la propia petición. Los libros y
  exportaciones largas sí necesitan el worker:
  ```bash
  docker run -d --name redis -p 6379:6379 redis:7
  celery -A app.workers.celery_app worker --loglevel=info -Q default,llm,exports --concurrency=2   # desde backend/
  ```
- Pruebas: `python -m pytest -q` (backend) y `npm test` (frontend). Las pruebas del backend usan un Firestore simulado y no llaman a la IA.
- Todo el stack con Docker: `docker compose up --build`.

## 5. Despliegue en Google Cloud (dev)

### 5.1 Automático (lo normal)

Cada push a `main` ejecuta `.github/workflows/deploy-dev.yml`: pruebas del backend y del frontend → construye y despliega la API →
despliega la web si cambió `frontend/` → reinicia el worker si está encendido → comprueba `GET /api/v1/health`.
Tarda ~8 minutos. GitHub se identifica con Workload Identity Federation (token temporal): no hay claves JSON en el repositorio.
Los cambios solo en `*.md`, `docs/` o `worker-vm.yml` no despliegan.

### 5.2 Primera vez (una sola vez, repetible)

Desde la raíz, con `gcloud` autenticado sobre `marketgen-dev`:

1. `python infra/gcp/load_secrets.py` — cuenta de servicio de la API y secretos en Secret Manager.
2. `python infra/gcp/setup_storage.py` — bucket de archivos, permisos y CORS.
3. `python infra/gcp/create_worker_vm.py` — VM del worker con Redis (IP interna fija `10.128.0.50`).
4. `python infra/gcp/setup_cicd.py main` — cuenta `marketgen-deployer` y la federación con GitHub (solo la rama `main`).
5. Primer despliegue de la API y la web (§5.3).

### 5.3 Manual (si el automático no está disponible)

```bash
# API (desde backend/)
gcloud builds submit . --tag=us-central1-docker.pkg.dev/marketgen-dev/marketgen/api:dev --project=marketgen-dev
python infra/gcp/deploy_api.py [orígenes CORS] [URL de la web]     # reemplaza TODAS las variables no secretas
# Web (desde frontend/)
gcloud builds submit . --config=cloudbuild.yaml --substitutions=_API_URL=https://<api>/api/v1 --project=marketgen-dev
gcloud run services update marketgen-web --image=us-central1-docker.pkg.dev/marketgen-dev/marketgen/web:dev --region=us-central1
```

Una imagen nueva con la **misma etiqueta `:dev`** no crea una revisión de Cloud Run por sí sola: cambiar algo, por ejemplo
`--update-env-vars=DEPLOYED_FROM=<commit>`.

### 5.4 Worker (VM)

- Encender, apagar o ver el estado: GitHub → Actions → **Worker VM (encender / apagar)** → Run workflow, o `python infra/gcp/vm.py start|stop|status`.
- Encendida cuesta ~US$0,02 por hora; apagada solo el disco. El arranque tarda ~1 minuto y descarga la imagen más reciente.
- Tras desplegar código nuevo, la VM debe reiniciarse para tomarlo (el despliegue automático lo hace si está encendida).
- Con la VM apagada la API sigue funcionando y la generación de propuestas corre en la propia petición.

### 5.5 Verificación posterior al despliegue

1. `curl https://<api>/api/v1/health` responde `200`.
2. Sin sesión, `GET /api/v1/proposals` responde `403` y `/docs` responde `404`.
3. Abrir la web, iniciar sesión y generar una propuesta.
4. Si se usan libros o exportaciones: encender el worker y confirmar que el trabajo termina.

### 5.6 Enviar correos desde Gmail (quien entra con Google)

Cada usuario conecta su propio buzón en Configuración › Pipeline › Buzón de envío: **Conectar Outlook** o **Conectar Gmail**.
Gmail usa la misma app de Google del login (`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`), pide el permiso
`gmail.compose` (crear borradores y enviarlos; **no puede leer la bandeja**) y Outlook sigue funcionando igual. Para que
funcione en un ambiente hay que hacer, una vez:

1. **Activar la API de Gmail** en el proyecto de Google Cloud: `gcloud services enable gmail.googleapis.com --project=marketgen-dev`.
2. **Registrar la URI de redirección** en el cliente OAuth (Google Cloud › APIs y servicios › Credenciales › cliente web):
   `https://<api>/api/v1/mail-connection/google/callback` y, para local, `http://127.0.0.1:8000/api/v1/mail-connection/google/callback`.
3. **Fijar `MAIL_GOOGLE_REDIRECT_URL`** en el servicio: `gcloud run services update marketgen-api --update-env-vars=MAIL_GOOGLE_REDIRECT_URL=https://<api>/api/v1/mail-connection/google/callback`
   (`deploy_api.py` ya la incluye). Además deben estar `PIPELINE_ENCRYPTION_KEY` (cifra los tokens) y, para enviar de verdad, `OUTREACH_REAL_SEND_ENABLED=true`.
4. **Agregar el permiso a la pantalla de consentimiento** (Google Auth Platform › Acceso a los datos): `https://www.googleapis.com/auth/gmail.compose`.
   Mientras la app esté en modo «Prueba», solo conectan las cuentas de la lista de usuarios de prueba, y Google **vence el acceso a los 7 días**:
   la pantalla muestra «Hay que reconectar» y el usuario vuelve a conectar. Para uso general, Google exige verificar la app (`gmail.compose` es un permiso restringido).

Detalles que conviene saber: el usuario puede desmarcar el permiso de Gmail en la pantalla de Google (entonces no se conecta y se le dice por qué);
Google devuelve el código por la URL (`?code=`), pero es de un solo uso y sin el verificador PKCE, que solo conoce el servidor, no sirve;
Gmail no permite saber si un borrador desaparecido se envió o lo borró el usuario, así que si se pierde la respuesta del envío el correo queda
«incierto» y el usuario decide (marcar como enviado o reintentar); lo que se envía y recibe de Gmail se prueba con `tests/test_gmail_connection.py`.

## 6. Comportamiento ante fallas (RNF-05, criterio 1)

| Falla | Qué ve el usuario | La aplicación |
|---|---|---|
| IA sin conexión o con error del proveedor | 502 «El servicio de IA no está disponible en este momento. Inténtalo de nuevo en unos minutos.» | Sigue funcionando |
| IA lenta (timeout) | 504 «El servicio de IA tardó demasiado en responder. Inténtalo de nuevo.» | Sigue funcionando |
| La IA devuelve texto que no es el JSON esperado (análisis) | 502 «La IA devolvió una respuesta que no se pudo interpretar.» | Sigue funcionando |
| CRM: credenciales vencidas | 401 con el mensaje del CRM; no cierra la sesión | Sigue funcionando |
| CRM: timeout / caído / sin red | 504 / 502 con mensaje; el intento queda registrado en `crmSync` | Sigue funcionando |
| Redis o worker apagados | La propuesta se genera dentro de la petición, unos segundos más lenta | Sigue funcionando |
| Fallo al subir un archivo a Cloud Storage | Error visible (no un enlace roto) | Sigue funcionando |

Pruebas automáticas: `backend/tests/test_rnf05_disponibilidad.py` (IA) y `backend/tests/test_proposals_crm.py` (CRM).

## 7. Problemas conocidos

| Síntoma | Causa y solución |
|---|---|
| `gcloud builds submit` falla con «forbidden … serviceusage.services.use» | Falta `storage.buckets.list`. `setup_cicd.py` crea el rol `bucketLister`; ejecutarlo de nuevo |
| El despliegue termina pero la API sigue con el código viejo | Misma etiqueta `:dev`: ver §5.3 (`DEPLOYED_FROM`) |
| El login con Google responde `redirect_uri_mismatch` | `GOOGLE_REDIRECT_URI` no coincide con la URI registrada en el cliente OAuth (§3) |
| Google rechaza a un usuario | La app está en modo de prueba: agregarlo en Google Auth Platform → Público → Usuarios de prueba |
| «Hay que reconectar» el buzón justo después de conectarlo en otro ambiente (motivo `tokens_unreadable`) | Local y dev tienen `PIPELINE_ENCRYPTION_KEY` distintas y comparten Firestore: cada uno no puede descifrar los tokens que guardó el otro y marca la conexión como rota. Usar la misma llave en ambos (§3). Si ya quedó marcada: volver a cifrar los tokens con la llave común o reconectar el buzón |
| El correo llega con las líneas cortadas a ~65 caracteres | Un correo solo de texto plano viaja con saltos a ~76 columnas y algunos clientes lo muestran como líneas cortas. Desde `9d68c2b` el envío por Gmail incluye una parte HTML con párrafos reales (`gmail_client.html_body`) |
| Gmail: «Hay que reconectar» a la semana | La app de Google está en modo «Prueba» y el acceso vence a los 7 días: el usuario reconecta |
| Gmail: `mail_service_unavailable` al enviar | La API de Gmail no está activada en el proyecto (§5.6, paso 1) |
| Un libro o exportación larga no avanza | Probablemente el worker está apagado: encenderlo (§5.4) |
| En local, un archivo generado no se descarga en la web | Con `STORAGE_BACKEND=supabase` y un Supabase inexistente cae al disco; usar `gcs` o aceptar que es solo local |

## 8. Costo aproximado (dev)

~US$1–3 al mes con la VM apagada; ~US$0,02 por hora con la VM encendida. La IA (DeepSeek) se factura aparte según el uso.
