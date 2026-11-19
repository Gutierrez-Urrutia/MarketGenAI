from datetime import datetime, timezone
import logging
import uuid

from jose import JWTError, jwt
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.config import settings
from app.core.client_ip import get_client_ip
from app.services.audit_service import write_log
from app.services.auth_service import JWT_ALGORITHM

logger = logging.getLogger(__name__)

SKIP_PATHS = ["/health", "/docs", "/openapi.json", "/redoc", "/favicon.ico"]
SKIP_METHODS = ["OPTIONS"]


def _infer_action(method: str, path: str) -> str:
    rules = [
        ("POST",  "/outreach-emails",       "",          "generated_prospecting_email"),
        ("PATCH", "/outreach-emails",       "approve",   "approved_prospecting_email"),
        ("PATCH", "/outreach-emails",       "reject",    "rejected_prospecting_email"),
        ("PATCH", "/outreach-emails",       "regenerate","regenerated_prospecting_email"),
        ("PATCH", "/outreach-emails",       "mark-sent", "sent_marked_prospecting_email"),
        # RF-VTA-06: antes caían en «created_proposal» / «deleted_proposal» (el orden importa: va primero).
        # RF-VTA-11: guardar y restaurar versiones también caían en «created_proposal».
        ("POST",  "/versions",              "restore",  "restored_proposal_version"),
        ("POST",  "/versions",              "",         "saved_proposal_version"),
        ("POST",  "/signed-document",       "",         "uploaded_signed_document"),
        ("DELETE","/signed-document",       "",         "removed_signed_document"),
        ("PATCH", "/outreach/review-queue", "approve",  "approved_outreach_message"),
        ("PATCH", "/outreach/review-queue", "reject",   "rejected_outreach_message"),
        ("PATCH", "/outreach/review-queue", "regenerate","regenerated_outreach_message"),
        ("PATCH", "/outreach/history",      "restore",  "restored_outreach_message"),
        ("DELETE","/outreach/history",      "",         "deleted_outreach_message"),
        ("POST",  "/outreach/generate",     "",         "generated_campaign_outreach"),
        ("PATCH", "/proposals",             "status",   "updated_proposal_status"),
        ("POST",  "/proposals",             "send-to-crm", "sent_proposal_to_crm"),
        ("POST",  "/crm/proposals",         "send",     "sent_proposal_to_crm"),
        ("POST",  "/proposals",             "generate", "generated_proposal"),
        ("POST",  "/proposals",             "",         "created_proposal"),
        ("PUT",   "/proposals",             "",         "updated_proposal"),
        ("PATCH", "/proposals",             "",         "updated_proposal"),
        ("DELETE","/proposals",             "",         "deleted_proposal"),
        ("PATCH", "/campaigns",             "status",   "updated_campaign_status"),
        ("POST",  "/campaigns",             "generate", "generated_campaign_content"),
        ("POST",  "/campaigns",             "",         "created_campaign"),
        ("POST",  "/opportunities",         "",         "created_opportunity"),
        ("PUT",   "/opportunities",         "",         "updated_opportunity"),
        ("DELETE","/opportunities",         "",         "deleted_opportunity"),
        ("PATCH", "/auth/users",            "roles",    "updated_user_roles"),
        ("POST",  "/content/generate",      "",         "generated_content_item"),
        # service-types first: "/catalog/services" is not a prefix of it, but keep the specific rule on top.
        ("POST",  "/customers/import",      "",         "imported_customers"),
        ("POST",  "/customers",             "",         "created_customer"),
        ("PUT",   "/customers",             "",         "updated_customer"),
        ("DELETE","/customers",             "",         "deleted_customer"),
        ("POST",  "/catalog/service-types", "",         "created_service_type"),
        ("PATCH", "/catalog/service-types", "",         "updated_service_type"),
        ("POST",  "/catalog/services",      "",         "created_service"),
        ("PATCH", "/catalog/services",      "",         "updated_service"),
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
        # RNF-02: las lecturas no se auditan (solo ruido) y las acciones que el router
        # ya registró con audit_service no se duplican con una entrada genérica.
        if method == "GET":
            return response
        if getattr(request.state, "audit_handled", False):
            return response

        try:
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
                "action": getattr(request.state, "audit_action", None) or _infer_action(method, path),
                "method": method,
                "path": path,
                "statusCode": response.status_code,
                "status": "success" if response.status_code < 400 else "failed",
                "ip": get_client_ip(request),
                "userAgent": request.headers.get("user-agent"),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            await write_log(log)
        except Exception:
            logger.exception("AuditMiddleware: no se pudo registrar %s %s", method, path)

        return response
