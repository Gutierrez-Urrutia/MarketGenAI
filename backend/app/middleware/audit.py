from datetime import datetime, timezone
import uuid

from jose import JWTError, jwt
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.config import settings
from app.services.auth_service import JWT_ALGORITHM

SKIP_PATHS = ["/health", "/docs", "/openapi.json", "/redoc", "/favicon.ico"]
SKIP_METHODS = ["OPTIONS"]


def _infer_action(method: str, path: str) -> str:
    rules = [
        ("PATCH", "/outreach/review-queue", "approve",  "approved_outreach_message"),
        ("PATCH", "/outreach/review-queue", "reject",   "rejected_outreach_message"),
        ("PATCH", "/outreach/review-queue", "regenerate","regenerated_outreach_message"),
        ("PATCH", "/outreach/history",      "restore",  "restored_outreach_message"),
        ("DELETE","/outreach/history",      "",         "deleted_outreach_message"),
        ("POST",  "/outreach/generate",     "",         "generated_campaign_outreach"),
        ("PATCH", "/proposals",             "status",   "updated_proposal_status"),
        ("POST",  "/proposals",             "generate", "generated_proposal"),
        ("POST",  "/proposals",             "",         "created_proposal"),
        ("DELETE","/proposals",             "",         "deleted_proposal"),
        ("PATCH", "/campaigns",             "status",   "updated_campaign_status"),
        ("POST",  "/campaigns",             "generate", "generated_campaign_content"),
        ("POST",  "/campaigns",             "",         "created_campaign"),
        ("POST",  "/opportunities",         "",         "created_opportunity"),
        ("PUT",   "/opportunities",         "",         "updated_opportunity"),
        ("DELETE","/opportunities",         "",         "deleted_opportunity"),
        ("PATCH", "/auth/users",            "roles",    "updated_user_roles"),
        ("POST",  "/content/generate",      "",         "generated_content_item"),
    ]
    for m, p, sub, label in rules:
        if method == m and p in path and (not sub or sub in path):
            return label
    # Fallback genérico
    actions = {"POST": "created", "PUT": "updated", "PATCH": "updated", "DELETE": "deleted", "GET": "viewed"}
    resource = path.split("/")[-1] if path else "unknown"
    return f"{actions.get(method, 'accessed')}_{resource}"


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)

        if not settings.audit_log_enabled:
            return response

        path = request.url.path
        method = request.method

        if method in SKIP_METHODS:
            return response
        if any(path.startswith(p) for p in SKIP_PATHS):
            return response
        if not path.startswith("/api/"):
            return response

        try:
            from app.services.firestore_service import get_db

            user_id = None
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                try:
                    token = auth_header.split(" ", 1)[1]
                    payload = jwt.decode(
                        token,
                        settings.app_secret_key,
                        algorithms=[JWT_ALGORITHM],
                    )
                    user_id = payload.get("sub")
                except JWTError:
                    pass

            log = {
                "id": str(uuid.uuid4()),
                "userId": user_id or "anonymous",
                "action": _infer_action(method, path),
                "method": method,
                "path": path,
                "statusCode": response.status_code,
                "ip": request.client.host if request.client else None,
                "userAgent": request.headers.get("user-agent"),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            await get_db().collection("auditLogs").document(log["id"]).set(log)
        except Exception:
            pass

        return response
