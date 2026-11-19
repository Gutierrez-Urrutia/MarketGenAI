"""Health check endpoint — no auth required."""
from datetime import datetime, timezone

import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.services.firestore_service import check_firestore_connection

router = APIRouter(tags=["Health"])
logger = logging.getLogger(__name__)

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
    try:
        await check_firestore_connection()
        return {
            "status": "ok",
            "database": "firestore",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:
        # RNF-04: 503 (los monitores lo ven como caído) y sin el texto de la excepción, que puede traer proyecto, credenciales o rutas
        logger.error("Health /db: Firestore no responde: %r", exc)
        return JSONResponse(status_code=503, content={
            "status": "error",
            "database": "firestore",
            "message": "La base de datos no está disponible.",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

