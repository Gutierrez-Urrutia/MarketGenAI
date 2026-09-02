"""Health check endpoint — no auth required."""
from datetime import datetime, timezone

from fastapi import APIRouter

from app.services.firestore_service import check_firestore_connection

router = APIRouter(tags=["Health"])

APP_VERSION = "1.0.0"


@router.get("/health")
async def health_check():
    return {
        "status":    "ok",
        "version":   APP_VERSION,
        "service":   "NoonDalton AI Marketing Suite API",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/health/db")
async def database_health_check():
    await check_firestore_connection()
    return {
        "status": "ok",
        "database": "firestore",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
