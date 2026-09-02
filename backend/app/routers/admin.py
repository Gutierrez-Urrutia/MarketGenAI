from fastapi import APIRouter, Depends, Query
from google.cloud.firestore_v1 import Query as FSQuery

from app.core.rbac import require_role
from app.dependencies.auth import CurrentUser, get_current_user
from app.services.firestore_service import get_db

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/audit-logs")
async def get_audit_logs(
    user: CurrentUser = Depends(get_current_user),
    limit: int = Query(50, le=200),
    userId: str = Query(None),
):
    require_role("manager")(user)
    col = get_db().collection("auditLogs")
    query = col.order_by("timestamp", direction=FSQuery.DESCENDING).limit(limit)
    if userId:
        query = col.where("userId", "==", userId).order_by("timestamp", direction=FSQuery.DESCENDING).limit(limit)
    docs = query.stream()
    return {"logs": [{"id": d.id, **d.to_dict()} async for d in docs]}
