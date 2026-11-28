"""Bloqueo temporal por intentos de inicio de sesión fallidos (RNF-01, CP-162).

El límite por IP de `@limiter.limit` frena a un atacante desde una dirección; esto frena además el ataque a UNA cuenta
repartido entre muchas direcciones. Se cuenta por correo normalizado, exista o no la cuenta, para que la respuesta no
revele qué correos están registrados. Tras `login_max_attempts` fallos dentro de la ventana, la cuenta queda bloqueada
`login_lock_minutes`; un inicio de sesión correcto borra el contador.

Si el almacén de intentos falla, el inicio de sesión sigue su curso (se registra el error): una caída de esta protección
no debe dejar a todos sin poder entrar, y la base de usuarios ya responde 503 por su cuenta si no está disponible.
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from app.config import settings
from app.services.firestore_service import login_attempts_repo

logger = logging.getLogger("marketgen.auth")


class LoginLocked(Exception):
    def __init__(self, retry_after_seconds: int):
        super().__init__(f"locked for {retry_after_seconds}s")
        self.retry_after_seconds = max(1, int(retry_after_seconds))

    @property
    def retry_after_minutes(self) -> int:
        return max(1, math.ceil(self.retry_after_seconds / 60))


def _key(identifier: str) -> str:
    return hashlib.sha256((identifier or "").strip().lower().encode("utf-8")).hexdigest()


def _aware(value: Any) -> Optional[datetime]:
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_not_locked(identifier: str) -> None:
    """Lanza LoginLocked si la cuenta sigue bloqueada."""
    try:
        state = await login_attempts_repo.get(_key(identifier))
    except Exception:
        logger.warning("login throttle: no se pudo leer los intentos", exc_info=True)
        return
    locked_until = _aware((state or {}).get("lockedUntil"))
    if locked_until and locked_until > _now():
        raise LoginLocked((locked_until - _now()).total_seconds())


async def record_failure(identifier: str) -> None:
    """Suma un intento fallido; lanza LoginLocked cuando con este se alcanza el límite."""
    key = _key(identifier)
    now = _now()
    try:
        state = await login_attempts_repo.get(key) or {}
        window = timedelta(minutes=settings.login_attempt_window_minutes)
        first = _aware(state.get("firstFailedAt"))
        count = int(state.get("failedCount") or 0)
        if not first or now - first > window:     # ventana vencida: se empieza de nuevo
            first, count = now, 0
        count += 1
        payload = {"failedCount": count, "firstFailedAt": first, "lockedUntil": None}
        if count >= settings.login_max_attempts:
            payload["lockedUntil"] = now + timedelta(minutes=settings.login_lock_minutes)
            payload["failedCount"] = 0
        await login_attempts_repo.create(payload, doc_id=key)
    except Exception:
        logger.warning("login throttle: no se pudo registrar el intento fallido", exc_info=True)
        return
    if payload["lockedUntil"]:
        raise LoginLocked(settings.login_lock_minutes * 60)


async def record_success(identifier: str) -> None:
    """Un inicio de sesión correcto borra el contador de esa cuenta."""
    try:
        await login_attempts_repo.delete(_key(identifier))
    except Exception:
        logger.warning("login throttle: no se pudo borrar el contador", exc_info=True)
