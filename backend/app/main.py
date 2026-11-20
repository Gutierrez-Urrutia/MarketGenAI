import logging

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.api_core import exceptions as google_exceptions
from google.auth import exceptions as google_auth_exceptions
from openai import OpenAIError
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.config import missing_required, settings
from app.core.errors import DB_QUOTA, DB_UNAVAILABLE, ENCRYPTION_NOT_CONFIGURED, LLM_TIMEOUT, LLM_UNAVAILABLE, STORAGE_UNAVAILABLE
from app.services.encryption_service import EncryptionNotConfiguredError
from app.services.storage_service import StorageError
from app.core.rate_limit import limiter
from app.middleware.audit import AuditMiddleware
from app.services.deepseek_service import LLMTimeoutError
from app.routers.admin import router as admin_router
from app.routers import (
    analysis,
    assets,
    assistant,
    auth,
    books,
    campaigns,
    catalog,
    content_types,
    customers,
    health,
    jobs,
    knowledge,
    leads,
    mail_connection,
    oauth,
    outreach,
    outreach_emails,
    opportunities,
    pipeline,
    platform,
    proposals,
    publishing,
    reports,
    sales_enablement,
    settings as settings_router,
    social,
    social_mock,
    tasks,
    templates,
)

logger = logging.getLogger("marketgen.main")
_faltantes = missing_required(settings)
if _faltantes:   # RNF-04: fuera de producción solo se avisa (en producción el arranque ya se detuvo en config.py)
    logger.warning("Faltan variables de entorno obligatorias en producción: %s. Ver docs/MANUAL-DESPLIEGUE.md §3.", ", ".join(_faltantes))
_is_prod = settings.app_env.lower() == "production"
app = FastAPI(
    title="MarketGen AI API",
    version="1.0.0",
    description="Backend API for MarketGen AI",
    # En producción no se publica la documentación interactiva (Swagger/ReDoc/OpenAPI).
    docs_url=None if _is_prod else "/docs",
    redoc_url=None if _is_prod else "/redoc",
    openapi_url=None if _is_prod else "/openapi.json",
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = jsonable_encoder(exc.errors())
    first_message = errors[0]["msg"] if errors else "Solicitud inválida."
    return JSONResponse(status_code=422, content={"detail": errors, "message": first_message})

# RNF-05: si la IA (DeepSeek) falla o no responde, el usuario recibe un aviso claro y la aplicación sigue
# funcionando. Solo actúa sobre errores que ningún router manejó; antes terminaban en un 500 sin mensaje.
_LLM_UNAVAILABLE = LLM_UNAVAILABLE
_LLM_TIMEOUT = LLM_TIMEOUT


@app.exception_handler(LLMTimeoutError)
async def llm_timeout_handler(request: Request, exc: LLMTimeoutError):
    logger.warning("LLM timeout en %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(status_code=504, content={"detail": _LLM_TIMEOUT, "message": _LLM_TIMEOUT})


@app.exception_handler(OpenAIError)
async def llm_error_handler(request: Request, exc: OpenAIError):
    logger.error("Falla del servicio de IA en %s %s: %r", request.method, request.url.path, exc)
    return JSONResponse(status_code=502, content={"detail": _LLM_UNAVAILABLE, "message": _LLM_UNAVAILABLE})


# RNF-04: si Firestore no responde, el usuario recibe un 503 claro (con CORS, para que el navegador lo lea) en lugar de un 500 sin
# mensaje; el detalle (proyecto, credenciales, rutas) queda solo en el log. /health sigue respondiendo.
@app.exception_handler(google_exceptions.ResourceExhausted)
async def db_quota_handler(request: Request, exc: google_exceptions.ResourceExhausted):
    logger.error("Cuota de la base de datos agotada en %s %s: %r", request.method, request.url.path, exc)
    return JSONResponse(status_code=503, content={"detail": DB_QUOTA, "message": DB_QUOTA, "code": "db_quota"})


@app.exception_handler(google_exceptions.GoogleAPICallError)
@app.exception_handler(google_exceptions.RetryError)
@app.exception_handler(google_auth_exceptions.GoogleAuthError)   # credenciales de Firestore ausentes o inválidas (DefaultCredentialsError, RefreshError)
async def db_unavailable_handler(request: Request, exc: Exception):
    logger.error("Falla de la base de datos en %s %s: %r", request.method, request.url.path, exc)
    return JSONResponse(status_code=503, content={"detail": DB_UNAVAILABLE, "message": DB_UNAVAILABLE, "code": "db_unavailable"})


# RNF-04: si falla el almacenamiento de archivos (GCS) o falta la llave de cifrado, también un aviso claro con CORS (antes: 500 sin mensaje).
@app.exception_handler(StorageError)
async def storage_error_handler(request: Request, exc: StorageError):
    logger.error("Falla del almacenamiento en %s %s: %r", request.method, request.url.path, exc)
    return JSONResponse(status_code=503, content={"detail": STORAGE_UNAVAILABLE, "message": STORAGE_UNAVAILABLE, "code": "storage_unavailable"})


@app.exception_handler(EncryptionNotConfiguredError)
async def encryption_not_configured_handler(request: Request, exc: EncryptionNotConfiguredError):
    logger.error("Llave de cifrado no configurada en %s %s: %r", request.method, request.url.path, exc)
    return JSONResponse(status_code=503, content={"detail": ENCRYPTION_NOT_CONFIGURED, "message": ENCRYPTION_NOT_CONFIGURED, "code": "encryption_not_configured"})


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AuditMiddleware)


@app.get("/")
def home():
    return {"message": "Backend MarketGen AI funcionando"}


app.include_router(auth.router, prefix="/api/v1")
app.include_router(admin_router, prefix="/api/v1")
app.include_router(oauth.router, prefix="/api/v1")
app.include_router(health.router, prefix="/api/v1")
app.include_router(outreach.router, prefix="/api/v1/outreach", tags=["outreach"])
app.include_router(books.router, prefix="/api/v1")
app.include_router(campaigns.router, prefix="/api/v1")
app.include_router(content_types.router, prefix="/api/v1/content", tags=["content"])
app.include_router(opportunities.router, prefix="/api/v1")
app.include_router(pipeline.router, prefix="/api/v1")
app.include_router(leads.router, prefix="/api/v1")
app.include_router(outreach_emails.router, prefix="/api/v1")
app.include_router(mail_connection.router, prefix="/api/v1")
app.include_router(customers.router, prefix="/api/v1")
app.include_router(knowledge.router, prefix="/api/v1")
app.include_router(sales_enablement.router, prefix="/api/v1")
app.include_router(templates.router, prefix="/api/v1")
app.include_router(catalog.router, prefix="/api/v1")
app.include_router(assets.router, prefix="/api/v1")
app.include_router(jobs.router, prefix="/api/v1")
app.include_router(platform.router, prefix="/api/v1")
app.include_router(reports.router, prefix="/api/v1")
app.include_router(analysis.router, prefix="/api/v1")
app.include_router(publishing.router, prefix="/api/v1")
app.include_router(settings_router.router, prefix="/api/v1")
app.include_router(proposals.router, prefix="/api/v1")
# social must be registered before social_mock: both define overlapping
# /settings/social/* paths, and Starlette uses the first route that matches —
# this lets facebook/instagram hit the real handlers while every other
# platform still falls through to the mock.
app.include_router(social.router, prefix="/api/v1")
app.include_router(social_mock.router, prefix="/api/v1")
app.include_router(assistant.router, prefix="/api/v1")
app.include_router(tasks.router, prefix="/api/v1")
