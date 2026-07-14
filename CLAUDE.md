# MarketGen AI — Contexto del proyecto

Plataforma SaaS de marketing con IA (NoonDalton AI Marketing Suite).
Defensa del proyecto: **10 de julio de 2026**.

## Stack
- **Backend:** FastAPI (Python), desplegado en Vercel (serverless, `api/index.py` → `backend/app/main.py`). Render ya no se usa (servicio eliminado/pausado). URL real: `https://market-gen-ai-6lzt.vercel.app`.
- **Frontend:** React + Vite, desplegado en Vercel. URL real: `https://marketgenai.vercel.app`.
- **Base de datos:** Firestore (vía `services/firestore_service.py`).
- **Auth:** JWT. `dependencies/auth.py` define la clase `CurrentUser`, `verify_token` (alias `get_current_user = verify_token`) y `require_roles()` (definida pero **no usada actualmente** en ningún router).

## Estructura
- Backend: `backend/app/` → `routers/`, `schemas/`, `services/`, `dependencies/`, `workers/`, `models/`.
  - **Atención:** `models/proposal.py` y `database.py` son código legado (SQLAlchemy + Postgres local con credenciales hardcodeadas). No se usan en producción (la app real usa Firestore) y solo los referencia `routers/proposals_mock.py`, que tampoco está registrado en `main.py`. No los uses como referencia ni "arregles" sus credenciales.
  - `routers/` contiene varios `*_mock.py`. La mayoría son código muerto (no registrados en `main.py`), **excepto `social_mock.py`**, que SÍ está montado en `/api/v1/social/*` (connect/disconnect) y no tiene autenticación — ver "Estado actual".
- Frontend: `frontend/src/` → `pages/`, `components/` (incluye `components/ui/`), `context/`, `hooks/`, `i18n/`, `api/` (clientes HTTP: `axios.js`, `proposalsApi.js`, `customersApi.js`, `templatesApi.js`, `dashboardApi.js`), `store/` (estado global, ej. `authStore.js`).

## Reglas que SIEMPRE debes seguir
1. **No debilitar la seguridad.** Todo endpoint lleva `user: CurrentUser = Depends(get_current_user)` y filtra por `userId == user.sub`. Si un endpoint falla, arréglalo devolviendo 401/403 limpios — NUNCA lo dejes público ni envuelvas el error en un try/except que se lo trague.
2. **Patrón de ownership:** usa helpers `_assert_owner` / `_get_X_for_user` igual que en `routers/books.py`. Replica ese patrón, no inventes uno nuevo.
3. **i18n desde el inicio:** todo texto visible va con `t()` y se agrega a `i18n/translations.js` en los 3 idiomas (en, es, pt). NO hardcodear strings.
4. **No romper shapes de respuesta** que el frontend ya consume. Antes de cambiar un response, revisa cómo lo usa el frontend.
5. **Usar los primitivos locales definidos dentro de `Dashboard.jsx`** (`Btn`, `Card`, `Field`, `Input`, `Select`, `Badge`, etc.) para UI nueva — es el árbol que realmente se renderiza (`App.jsx` → `Dashboard.jsx`). `pages/*` y `components/ui/` son en su mayoría código no enrutado: NO importar desde ahí. **Única excepción confirmada:** `pages/chat/Chat.jsx` sí se importa desde `Dashboard.jsx` y sí está vivo, junto con sus dos dependencias `components/ui/Button.jsx` y `components/ui/Spinner.jsx` (el resto de `components/ui/` solo lo usa el árbol muerto de `pages/*`).

## Estado actual (ya hecho — no rehacer)
- `proposals.py`, `platform.py`, `reports.py`: ya autenticados (`Depends(get_current_user)`) y filtrados por userId.
- `assistant.py`: ya autenticado (`Depends(get_current_user)`), pero es un endpoint de chat sin estado (no lee/escribe datos propios del usuario), por lo que no aplica filtro por userId.
- `proposals.py`: ya tipado con schemas Pydantic (`extra="allow"`). No tocar su seguridad ni su tipado.
- `config.py`: ya valida que `APP_SECRET_KEY` no sea el default en producción.
- `APP_ENV=production` y `APP_SECRET_KEY` ya configurados en el proyecto Vercel del backend (env vars del dashboard, no en el repo).
- `social_mock.router` (`/api/v1/social/*`, `connect`/`disconnect`): ya requiere `Depends(get_current_user)` (commit `edd99b6`). Sigue siendo un mock (no persiste estado), por eso no filtra por `userId`.

## Próximas tareas (orden de prioridad para la defensa)
1. Wizard **Create Proposal** (3 pasos) conectado al botón del Dashboard. Ya hay avance: `Dashboard.jsx` tiene estado `wizardStep` y un `CampaignModal` — verificar qué falta en vez de empezar de cero.
2. Módulo **Campaigns** (flujo de 7 pasos que reutiliza Opportunities, AI Assistant, Book Concepts, Content Library, Outreach, Reports). Ya existen `OpportunitiesPage`, `ContentLibraryPage`, `OutreachPage` y `CampaignModal` dentro de `Dashboard.jsx` — revisar cobertura real antes de planificar el flujo completo.
3. Auditoría de logs (middleware + colección Firestore `auditLogs`). Confirmado: nada de esto existe aún en el backend.
4. i18n del Sidebar y páginas principales. Confirmado: `components/layout/Sidebar.jsx` sigue con labels hardcodeados en español ("Propuestas", "Clientes", "Reportes", "Configuración", etc.) — sigue pendiente.

## Cómo trabajar conmigo (para ahorrar contexto)
- Una tarea por sesión. Al terminar, resume en 3-5 líneas qué cambiaste.
- Antes de un cambio grande, dime el plan en bullets y espera OK.
- Apunta a archivos/líneas concretas en vez de releer todo el repo.
