"""RNF-02 · Trazabilidad y auditoría.

Cada acción sobre una propuesta (crear, generar, editar, cambiar de estado,
versionar, enviar al CRM, eliminar) deja un registro con usuario, acción, fecha
e IP en la colección `auditLogs`. Este servicio escribe el esquema único; el
middleware HTTP (`middleware/audit.py`) queda como red de seguridad para el
resto de las rutas.

Esquema de `auditLogs`:
    id, userId, userEmail, roles, action, resourceType, resourceId, ip,
    method, path, status ("success" | "failed"), details, timestamp (ISO UTC)
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from starlette.requests import Request

from app.core.client_ip import get_client_ip

logger = logging.getLogger(__name__)

# Acciones de propuesta (RNF-02). `proposal_status_changed` la escribe la transacción
# de `ProposalsRepo.change_status`, el resto `record()`.
PROPOSAL_CREATED = "proposal_created"
PROPOSAL_GENERATED = "proposal_generated"
PROPOSAL_UPDATED = "proposal_updated"
PROPOSAL_STATUS_CHANGED = "proposal_status_changed"
PROPOSAL_VERSION_SAVED = "proposal_version_saved"
PROPOSAL_VERSION_RESTORED = "proposal_version_restored"
PROPOSAL_SENT_TO_CRM = "proposal_sent_to_crm"
PROPOSAL_DELETED = "proposal_deleted"

PROPOSAL_ACTIONS = (
    PROPOSAL_CREATED,
    PROPOSAL_GENERATED,
    PROPOSAL_UPDATED,
    PROPOSAL_STATUS_CHANGED,
    PROPOSAL_VERSION_SAVED,
    PROPOSAL_VERSION_RESTORED,
    PROPOSAL_SENT_TO_CRM,
    PROPOSAL_DELETED,
)


def now_iso() -> str:
    """Mismo formato que el middleware: el listado ordena y filtra por este texto."""
    return datetime.now(timezone.utc).isoformat()


def mark_handled(request: Optional[Request]) -> None:
    """Avisa al middleware HTTP de que la acción ya quedó auditada, para que no
    escriba una segunda entrada genérica."""
    if request is not None:
        request.state.audit_handled = True


async def write_log(log: Dict[str, Any]) -> bool:
    """Escribe un registro. Nunca lanza: un fallo de auditoría no debe tumbar la
    acción de negocio ya hecha, pero tampoco se silencia (queda en el log de la app)."""
    try:
        from app.services.firestore_service import audit_logs_repo

        await audit_logs_repo.add(log)
        return True
    except Exception:
        logger.exception(
            "No se pudo escribir el registro de auditoría (action=%s, resourceId=%s)",
            log.get("action"), log.get("resourceId"),
        )
        return False


async def record(
    *,
    action: str,
    resource_id: Optional[str],
    user_id: Optional[str] = None,
    user_email: Optional[str] = None,
    roles: Optional[List[str]] = None,
    request: Optional[Request] = None,
    ip: Optional[str] = None,
    resource_type: str = "proposal",
    status: str = "success",
    details: Optional[Dict[str, Any]] = None,
) -> bool:
    """Registra una acción de dominio. Con `request` toma IP, método y ruta de ahí
    (y marca la petición como ya auditada); sin él (workers) hay que pasar `ip`."""
    log = {
        "id": str(uuid.uuid4()),
        "userId": user_id or "anonymous",
        "userEmail": user_email,
        "roles": list(roles or []),
        "action": action,
        "resourceType": resource_type,
        "resourceId": resource_id,
        "ip": ip if ip is not None else (get_client_ip(request) if request is not None else None),
        "method": request.method if request is not None else None,
        "path": request.url.path if request is not None else None,
        "status": status,
        "details": details or {},
        "timestamp": now_iso(),
    }
    ok = await write_log(log)
    if ok:
        mark_handled(request)
    return ok
