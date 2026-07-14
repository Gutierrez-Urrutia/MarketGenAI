from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.config import settings
from app.core.rate_limit import limiter
from app.middleware.audit import AuditMiddleware
from app.routers.admin import router as admin_router
from app.routers import (
    analysis,
    assets,
    assistant,
    auth,
    books,
    campaigns,
    chat,
    content_types,
    customers,
    health,
    jobs,
    oauth,
    outreach,
    opportunities,
    platform,
    proposals,
    publishing,
    reports,
    settings as settings_router,
    social,
    social_mock,
    templates,
)

app = FastAPI(
    title="MarketGen AI API",
    version="1.0.0",
    description="Backend API for MarketGen AI",
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
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
app.include_router(customers.router, prefix="/api/v1")
app.include_router(templates.router, prefix="/api/v1")
app.include_router(assets.router, prefix="/api/v1")
app.include_router(jobs.router, prefix="/api/v1")
app.include_router(platform.router, prefix="/api/v1")
app.include_router(reports.router, prefix="/api/v1")
app.include_router(analysis.router, prefix="/api/v1")
app.include_router(publishing.router, prefix="/api/v1")
app.include_router(settings_router.router, prefix="/api/v1")
app.include_router(chat.router, prefix="/api/v1")
app.include_router(proposals.router, prefix="/api/v1")
# social must be registered before social_mock: both define overlapping
# /settings/social/* paths, and Starlette uses the first route that matches —
# this lets facebook/instagram hit the real handlers while every other
# platform still falls through to the mock.
app.include_router(social.router, prefix="/api/v1")
app.include_router(social_mock.router, prefix="/api/v1")
app.include_router(assistant.router, prefix="/api/v1")
