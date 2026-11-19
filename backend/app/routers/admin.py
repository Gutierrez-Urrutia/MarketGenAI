from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.rbac import is_admin
from app.dependencies.auth import CurrentUser, get_current_user
from app.services.firestore_service import audit_logs_repo

router = APIRouter(prefix="/admin", tags=["admin"])


def _bound(value: Optional[str], *, end_of_day: bool, name: str) -> Optional[str]:
    """Normaliza `from`/`to` al formato ISO UTC en que se guarda `timestamp`.
    Una fecha sola (YYYY-MM-DD) cubre el día completo."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"'{name}' debe ser una fecha ISO (AAAA-MM-DD o AAAA-MM-DDTHH:MM:SS).",
        )
    date_only = len(value) == 10
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    if date_only and end_of_day:
        parsed = parsed + timedelta(days=1) - timedelta(microseconds=1)
    return parsed.isoformat()


@router.get("/audit-logs")
async def get_audit_logs(
    user: CurrentUser = Depends(get_current_user),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    userId: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    resourceId: Optional[str] = Query(None, description="ID de la propuesta"),
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
):
    """RNF-02: registro de auditoría (usuario, acción, fecha, IP). Solo administradores."""
    if not is_admin(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo un administrador puede consultar el registro de auditoría.",
        )
    logs, has_more = await audit_logs_repo.search(
        user_id=userId,
        action=action,
        resource_id=resourceId,
        date_from=_bound(date_from, end_of_day=False, name="from"),
        date_to=_bound(date_to, end_of_day=True, name="to"),
        limit=limit,
        offset=offset,
    )
    return {"logs": logs, "limit": limit, "offset": offset, "hasMore": has_more}
