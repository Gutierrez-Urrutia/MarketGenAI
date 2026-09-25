# Expose Pipeline settings tab (Fase 1) + validation, i18n, docs

## Resumen

Expone y endurece la pestaña **Pipeline** (Fase 1 de infraestructura del pipeline de prospección de 3 agentes) en la pantalla de Configuración, que hasta ahora estaba completamente implementada pero inalcanzable desde la interfaz. Corrige validación de campos SMTP, traduce el módulo a los tres idiomas soportados, y agrega la documentación en español del README.

**Fase 1 del pipeline (contexto, sin cambios de este PR):** CRUD de `PipelineConfig` por usuario en Firestore (`backend/app/routers/pipeline.py`, `backend/app/schemas/pipeline.py`), configuración de fuentes de vacantes (`api`/`rss`/`scraper`/`webhook`) sin llamadas externas todavía, y credenciales SMTP cifradas con Fernet (`backend/app/services/encryption_service.py`). Las fases 2-6 (Agentes 1/2/3, orquestador, leads/contacts/outreach_emails, scan programado) están documentadas en `plan-pipeline-3-agentes.md` y no forman parte de este PR.

## Commits

1. **`35f16e5` fix(settings): expose Pipeline tab in settings** — agrega el botón de pestaña faltante y la clave i18n `settings.pipeline` (es/en/pt). `PipelineSettingsTab` estaba montado condicionalmente pero ningún botón disparaba `setTab("pipeline")`.
2. **`4d654ee` fix(pipeline): trim/validate SMTP fields, fix whitespace-password handling** — recorta espacios en `smtp_user`/`sender_email`/`sender_name` (frontend + backend), valida formato de `sender_email` (422 si es inválido). `smtp_password` nunca se recorta; una contraseña de solo espacios ahora se trata como "no proporcionada" (mantiene la guardada) en vez de borrarla. 7 tests nuevos.
3. **`6337092` i18n(pipeline): translate PipelineSettingsTab.jsx to es/en/pt** — mueve todos los textos visibles (títulos, labels, hints, botones, tooltips, 12 toasts) a `settings.pipelineTab.*` en los tres idiomas. De paso corrige un shadowing incidental (`(t) =>` tapaba la función de traducción `t()` en el callback de thresholds).
4. **`40232d8` docs: add Spanish README** — traducción completa de `README.md`, verificada contra el código real (no contra la documentación desactualizada): describe la auth real HS256/Firestore con nota de que Keycloak es legado, elimina una línea corrupta y contenido inconsistente del README original, agrega sección sobre la Fase 1 del pipeline.

## Resultado de los tests

- **Backend**: `pytest` completo (no solo el módulo de pipeline) → **179 passed**, 13 warnings — todos preexistentes (deprecaciones de `reportlab`, `gotrue`/supabase, `pydantic` `min_items`/class-config, `jose` `datetime.utcnow()`), ninguno nuevo introducido por este PR. Confirmado comparando contra la misma corrida en `HEAD` antes de los cambios (172 passed, mismos 13 warnings).
- **Frontend**: `npm run build` exitoso en cada commit de este PR. Único warning preexistente: chunk >500kB (deuda técnica de `Dashboard.jsx`, no relacionado con este cambio).
- Verificación manual en navegador: pestaña Pipeline visible y funcional, configuración persiste al recargar, contraseña SMTP nunca se re-muestra ("Configured — leave blank to keep it"), textos verificados en los tres idiomas.

## Nota para el equipo: `PIPELINE_ENCRYPTION_KEY`

El endpoint `PUT /api/v1/pipeline/config` cifra `smtp_password` con Fernet usando la variable de entorno `PIPELINE_ENCRYPTION_KEY`. **Si no está configurada, el endpoint responde `503`** (no crashea, pero bloquea el guardado de credenciales SMTP). Hay que generarla y setearla en cada entorno (dev/staging/prod) antes de que alguien intente configurar el pipeline desde la UI. Ejemplo para generar una clave Fernet válida:
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```
Ya está documentada en `backend/.env.example` y ahora también en `README.es.md`.

## Deuda técnica (fuera de alcance de este PR)

- `pages/settings/Settings.jsx`, `components/layout/Layout.jsx` y `components/layout/Sidebar.jsx`: código sin uso de un intento anterior con react-router — no están importados por ningún punto de entrada real de la app.
- `backend/main.py` (raíz de `backend/`, no `backend/app/main.py`): entrypoint antiguo sin uso, confirmado. `api/index.py` importa `app.main.app`; Dockerfile y `docker-compose.yml` arrancan `uvicorn app.main:app`; ningún archivo del repo importa ni ejecuta `main` a secas. Solo lo toca su commit inicial. Es candidato a borrarse en un PR aparte (tiene CORS con `allow_credentials=True`, así que conviene que no quede como trampa).
- `Dashboard.jsx` concentra toda la app en más de 12.000 líneas (single-file component con routing, todas las páginas y toda la lógica de negocio inline).
- Acción explícita para borrar la contraseña SMTP (el backend ya lo soporta con `""`; falta en la interfaz).
- ~~El frontend no tiene ningún ejecutor de pruebas~~ — resuelto: Vitest + jsdom + Testing Library configurados (`npm test`). Sigue habiendo muy pocos tests de interfaz; la cobertura es sobre todo de backend.
- Las acciones nuevas del pipeline caen al registro genérico de auditoría en vez de tener etiquetas descriptivas como las de la v1.
- Textos del Panel principal sin pasar por i18n (`frontend/src/Dashboard.jsx`): "Last updated:" y "Refreshing..." (~L3454-3455), las etiquetas de origen de datos de `dashboardSourceLabel` — "Based on backend data", "Based on local data", "Based on cached data", "Demo data" (~L2169-2174) — y el toast "Dashboard updated". Deben moverse a `src/i18n/translations.js` (es/en/pt).
- Panel principal: `DashboardPage` escucha el evento `storage` y cada refresco escribe un `savedAt` nuevo en localStorage; con dos pestañas abiertas se disparan refrescos entre sí sin fin (preexistente, código del commit inicial). Ver análisis en la conversación; pendiente de corrección.

## Revisión de seguridad — Fase 2

### Corregido (rama `Hernan`)

- SSRF y lectura de archivos locales en `JobScoutService` — `bc9001b`
- XSS almacenado por `job_url` con URIs `javascript:` — `f126efc`
- Tope de tamaño (streaming) en la descarga de fuentes — `5ec708b`
- Límite de uso `10/minute` en `POST /pipeline/runs` (mismo `slowapi` que `outreach.py`/`proposals.py`) — `215be33`
- `cryptography` 42.0.0 → 50.0.1 (respalda el cifrado Fernet de contraseñas SMTP y claves de API); ya no aparece en `pip-audit` — `406ca5a`

### Pendiente de decisión del equipo: CORS demasiado amplio

`backend/app/main.py` combina `allow_origin_regex=r"https://.*\.vercel\.app"` con `allow_credentials=True`. El regex acepta **cualquier** subdominio de `vercel.app`, incluidos despliegues de terceros, y con credenciales habilitadas el navegador permite que esos sitios envíen peticiones con credenciales a la API y lean la respuesta. Hoy el impacto está acotado porque la autenticación no viaja en cookies, pero cualquiera puede publicar un sitio en `*.vercel.app`, y si mañana se introduce una cookie de sesión, el riesgo se activa sin que nadie toque CORS.

**Verificación en el frontend:** no hay `withCredentials`, `credentials: "include"`, `document.cookie` ni librerías de cookies en `frontend/src`; el backend tampoco emite `Set-Cookie`. El token se envía solo como cabecera `Authorization: Bearer` (`frontend/src/api/axios.js:176`, `:200`).

**Propuesta:** poner `allow_credentials=False`. Como la autenticación es por cabecera Bearer, no se necesita, y el navegador deja de exponer respuestas autenticadas por cookies a orígenes arbitrarios. Las vistas previas Vercel del equipo siguen funcionando porque el regex no cambia. Opcionalmente, acotar el regex al prefijo del proyecto (p. ej. `https://marketgen-.*\.vercel\.app`).

**No aplicado:** vive en `main.py` (código compartido) y la decisión es del equipo. Nota: el `backend/main.py` de la raíz de `backend/` también tiene `allow_credentials=True`, pero está sin uso (ver deuda técnica), por lo que no afecta al comportamiento real.

### Tarea aparte: dependencias vulnerables (preexistentes, no introducidas por la Fase 2)

**Backend** (`pip-audit -r requirements.txt`): tras subir `cryptography` quedan **162 hallazgos en 11 paquetes** (eran 177 en 12). `pip-audit` no informa severidad; hay que cruzarlos con el detalle de cada advisory.

| Paquete | Versión | Hallazgos |
|---|---|---|
| pypdf | 5.1.0 | 77 |
| pillow | 11.0.0 | 33 |
| starlette | 0.41.3 | 14 |
| python-multipart | 0.0.12 | 14 |
| jinja2 | 3.1.4 | 6 |
| python-jose | 3.3.0 | 5 |
| weasyprint | 62.3 | 5 |
| anyio | 4.6.2 | 2 |
| ecdsa | 0.19.2 | 2 |
| pytest | 8.3.3 | 2 |
| python-dotenv | 1.0.1 | 2 |

**Frontend** (`npm audit`): **47 hallazgos — 0 críticos, 9 altos, 36 moderados, 2 bajos.** Dependencias directas afectadas:

| Paquete | Severidad |
|---|---|
| axios (1.0.0 – 1.17.0) | alta |
| vite (<=6.4.2) | alta |
| postcss (<=8.5.22) | alta |
| @tiptap/* (react, starter-kit, extension-image/link/placeholder/character-count) | moderada |
| react-router-dom (<=7.17.0) | moderada |
| uuid (<11.1.1) | moderada |

Actualizar starlette/python-multipart implica revisar compatibilidad con FastAPI; tratar en un PR propio con la suite completa.

## Latencia del escaneo y razonamiento de DeepSeek (medido)

**Causa de los ~116 s de una corrida de 3 vacantes:** no fue DeepSeek. `task_run_job_scout.delay()` es síncrono y, con Redis caído, tardó **108,8 s** en fallar (44 intentos de conexión de ~2,03 s en Windows), bloqueando el bucle de eventos de toda la API. El escaneo real, medido con temporizadores y sin escrituras, tomó **7,4 s** (descarga de la fuente 0,9 s, deduplicación 1,0 s, DeepSeek 5,5 s). Corregido en `3d4806d` (`.delay()` en un hilo con tope de `TASK_ENQUEUE_TIMEOUT_SECONDS` = 5 s). Con Celery real y Redis caído ahora cae al respaldo en 5,0 s con una parada máxima del bucle de 0,01 s.

**Razonamiento (`reasoning_effort="high"` con razonamiento activado): se midió y se decidió mantenerlo.** La configuración viene **heredada del commit `10c1e2b`** (integración de DeepSeek v4, cliente compartido `_generate_text_sync`, usado por 21 puntos de llamada); **no fue una decisión de diseño para la puntuación**, que no puede elegirla por llamada.

Medición real contra la API (modelo `deepseek-flash`, 25 vacantes de la fuente actual, lotes de 8 = 4 llamadas, mismo prompt y umbral 0,6). Se ejecutó la configuración actual dos veces para conocer el ruido natural antes de comparar; "referencia" es la primera pasada de la configuración actual de cada tanda. Son dos tandas independientes; una pasada por variante salvo la actual y "razonamiento desactivado" (tanda 1).

| Configuración | Tiempo (25 vacantes) | Dif. media de puntaje vs referencia | Vacantes que cambian de lado del umbral | Correlación (Spearman) |
|---|---|---|---|---|
| Actual, referencia | 52,3 s / 45,3 s | — | — | — |
| **Actual, 2.ª pasada (ruido natural)** | 48,6 s / 32,1 s | 0,088 / 0,144 | 2 / 5 | 0,96 / 0,86 |
| `medium` | 37,8 s | 0,043 | 1 | 0,93 |
| `low` | 41,7 s | 0,142 | 5 | 0,80 |
| Razonamiento desactivado | 14,1 s y 14,3 s / 16,3 s | 0,198 y 0,200 / 0,187 | 7 y 7 / 6 | 0,70 y 0,67 / 0,69 |

- Desactivar el razonamiento es ~3 veces más rápido, pero las puntuaciones difieren **más que el ruido natural** y en una dirección (aprueba **21 vacantes frente a 14-15**).
- `low` y `medium` casi no ahorran tiempo (37,8 y 41,7 s frente a 32-52 s de la actual).
- No hay verdad de referencia: solo se mide acuerdo entre configuraciones, no cuál puntúa mejor. Muestra pequeña (25 vacantes, una fuente).
- **Decisión: se mantiene la configuración actual.**
- **Proyección con lotes de 8:** 30 vacantes = 4 llamadas ≈ 50-60 s (medido con 25: 32-52 s). El tope de 100 por corrida = 13 llamadas ≈ 200 s, cerca del presupuesto de 240 s.

### Pendientes (no corregidos)

- `job_scout_service.py:507`: el bucle de lotes **no comprueba el presupuesto** (`RUN_TIME_BUDGET_SECONDS`); solo se comprueba al empezar cada fuente (`:471`). Con el tope de 100 vacantes por corrida podría pasarse.
- Las vacantes **bajo el umbral no se guardan**, así que se **vuelven a puntuar en cada corrida** (hoy 3 por corrida). Es costo en tokens, no un fallo.
- El mismo patrón de `.delay()` síncrono dentro de un manejador `async` existe en `routers/books.py` y `routers/publishing.py` (fuera del pipeline): con Redis caído bloquea el servidor igual. No se tocó.
- Pruebas sin hacer: el camino con Celery real (worker) y el vencimiento del plazo de 360 s del bloqueo de corridas.
- Si un publish a Celery termina después del tope (5 s), el escaneo ya corrió en línea: la tarea lo detecta (`status != running`) y no lo repite. Ventana residual: si la tarea llega mientras el respaldo todavía está corriendo, ambos podrían ejecutarse a la vez.

