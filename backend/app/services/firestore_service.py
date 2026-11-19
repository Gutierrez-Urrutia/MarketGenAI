"""
Firestore service — async client wrapper with typed helpers.

Collections used by this project:
  - users/{userId}
  - refreshTokens/{tokenHash}
  - passwordResetTokens/{tokenHash}
  - books/{bookId}
  - books/{bookId}/chapters/{chapterId}
  - proposals/{proposalId}
  - campaigns/{campaignId}
  - opportunities/{opportunityId}
  - customers/{customerId}
  - templates/{templateId}
  - assets/{assetId}
  - jobs/{jobId}
  - settings/{orgId}
  - pipeline_configs/{userId}    (one doc per user, doc_id = userId)
  - leads/{leadId}
  - contacts/{contactId}
  - outreach_emails/{emailId}
  - outreach_send_counters/{hash(userId, day)}   (platform sends per user and UTC day)
  - do_not_contact/{hash(userId, kind, value)}   (addresses / domains never to email)
  - mail_oauth_states/{hash(state)}   (pending mailbox connections: single use, expire)
  - mail_connections/{userId}         (connected Microsoft mailbox, tokens encrypted)
  - pipeline_runs/{runId}
  - knowledge_documents/{docId}   (RAG: propuestas históricas cargadas por el usuario)
  - knowledge_chunks/{chunkId}    (RAG: fragmentos de cada documento)
  - serviceCatalog/{serviceId}    (RF-VTA-02: catálogo de servicios de la empresa)
  - serviceCatalogKeys/{hash}     (clave única nombre+unidad del catálogo)
  - serviceTypes/{typeId}         (RF-VTA-02: tipos de servicio)
  - serviceTypeKeys/{hash}        (clave única del nombre de tipo)
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import uuid
import weakref
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from google.api_core.exceptions import FailedPrecondition
from google.oauth2 import service_account
from google.cloud import firestore
from google.cloud.firestore_v1.async_client import AsyncClient
from google.cloud.firestore_v1 import AsyncDocumentReference

from app.config import settings
from app.core.pipeline_constants import (
    CONTACT_REUSE_MAX_CANDIDATES,
    CONTACT_SEARCH_CONSIDERED_DEAD_AFTER_SECONDS,
    CONTACT_SEARCH_COOLDOWN_SECONDS,
    CONTACT_SEARCH_SEARCHABLE_STATUSES,
    COMPOSE_STARTABLE_STATUSES,
    COMPOSING_STALE_SECONDS,
    EMAIL_RECOMPUTABLE_STATUSES,
    MAIL_SEND_MAX_HTTP_CALLS,
    OUTREACH_EMAILS_PER_LEAD_LIMIT,
    SEND_LOCK_STALE_FACTOR,
)
from app.schemas.contact import ContactCreate
from app.schemas.outreach_email import ACTIVE_EMAIL_STATUSES, plan_email_transition, plan_send_lock
from app.schemas.proposal import (
    PROPOSAL_STATUS_VALUES,
    StatusChangeError,
    decide_cambio_estado,
    normalize_proposal_status,
)

logger = logging.getLogger("marketgen.firestore")

# ── Singleton client ──────────────────────────────────────────────────────────
_client: Optional[AsyncClient] = None


def get_db() -> AsyncClient:
    """Return the singleton Firestore async client."""
    global _client
    if _client is None:
        credentials = None
        source = "ADC (Default)"
        if settings.firebase_service_account_json and settings.firebase_service_account_json.strip():
            source = "FIREBASE_SERVICE_ACCOUNT_JSON"
            raw_json = settings.firebase_service_account_json.strip()
            logger.info(
                "🔍 [Firestore] FIREBASE_SERVICE_ACCOUNT_JSON detectado (len=%d, inicio='%s', fin='%s')",
                len(raw_json),
                raw_json[:40],
                raw_json[-20:],
            )
            try:
                sa_info = json.loads(raw_json)
                logger.info(
                    "🔍 [Firestore] JSON parseado correctamente. Claves presentes: %s",
                    sorted(sa_info.keys()) if isinstance(sa_info, dict) else type(sa_info),
                )
                credentials = service_account.Credentials.from_service_account_info(sa_info)
                logger.info(
                    "✅ [Firestore] Credenciales cargadas exitosamente desde FIREBASE_SERVICE_ACCOUNT_JSON (project='%s', email='%s')",
                    sa_info.get("project_id"),
                    sa_info.get("client_email"),
                )
            except json.JSONDecodeError as exc:
                logger.error("❌ [Firestore] FIREBASE_SERVICE_ACCOUNT_JSON no es JSON válido: %s", exc)
            except Exception as exc:
                logger.error("❌ [Firestore] Fallo al parsear FIREBASE_SERVICE_ACCOUNT_JSON: %s", exc)
        elif settings.firebase_credentials_path:
            source = f"FIREBASE_CREDENTIALS_PATH ({settings.firebase_credentials_path})"
            try:
                credentials = service_account.Credentials.from_service_account_file(
                    settings.firebase_credentials_path
                )
                logger.info("✅ [Firestore] Credenciales cargadas desde archivo: %s", settings.firebase_credentials_path)
            except Exception as exc:
                logger.error("❌ [Firestore] Fallo al cargar credenciales desde %s: %s", settings.firebase_credentials_path, exc)
        elif settings.google_application_credentials:
            source = f"GOOGLE_APPLICATION_CREDENTIALS ({settings.google_application_credentials})"
            try:
                credentials = service_account.Credentials.from_service_account_file(
                    settings.google_application_credentials
                )
                logger.info("✅ [Firestore] Credenciales cargadas desde archivo: %s", settings.google_application_credentials)
            except Exception as exc:
                logger.error("❌ [Firestore] Fallo al cargar credenciales desde %s: %s", settings.google_application_credentials, exc)
        else:
            logger.warning(
                "⚠️ [Firestore] No se especificaron credenciales explícitas. Usando Application Default Credentials (ADC)..."
            )

        _client = firestore.AsyncClient(
            project=settings.google_cloud_project or None,
            database=settings.firestore_database,
            credentials=credentials,
        )
        logger.info(
            "🚀 [Firestore] Cliente AsyncClient inicializado con éxito (project='%s', db='%s', origen='%s')",
            settings.google_cloud_project,
            settings.firestore_database,
            source,
        )
    return _client


async def check_firestore_connection() -> bool:
    """Run a tiny read to verify Firestore credentials and network access."""
    try:
        logger.info("🔍 [Firestore] Probando conexión a Firestore con ping a '_health'...")
        await get_db().collection("_health").limit(1).get()
        logger.info("✅ [Firestore] Conexión a Firestore verificada exitosamente.")
        return True
    except Exception as exc:
        logger.error("❌ [Firestore] Error en ping a Firestore: %s", exc)
        raise


# ── Timestamp helpers ─────────────────────────────────────────────────────────
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid.uuid4())


# ── Generic CRUD helpers ──────────────────────────────────────────────────────
class FirestoreRepo:
    """
    Base repository providing generic create/read/update/delete helpers.
    Subclass and set `collection` to the Firestore collection name.
    """

    collection: str = ""

    def __init__(self):
        pass

    @property
    def db(self) -> AsyncClient:
        return get_db()

    def _col(self):
        return self.db.collection(self.collection)

    def _doc(self, doc_id: str) -> AsyncDocumentReference:
        return self._col().document(doc_id)

    # ── Create ────────────────────────────────────────────────────────────────
    async def create(self, data: Dict[str, Any], doc_id: Optional[str] = None) -> Dict[str, Any]:
        """Create a document. Auto-generates ID if not provided."""
        doc_id = doc_id or new_id()
        now = now_utc()
        payload = {
            **data,
            "id": doc_id,
            "createdAt": now,
            "updatedAt": now,
        }
        await self._doc(doc_id).set(payload)
        return payload

    # ── Read one ──────────────────────────────────────────────────────────────
    async def get(self, doc_id: str) -> Optional[Dict[str, Any]]:
        """Return a document by ID, or None if not found."""
        snap = await self._doc(doc_id).get()
        return snap.to_dict() if snap.exists else None

    async def get_or_404(self, doc_id: str) -> Dict[str, Any]:
        """Return a document by ID or raise KeyError (caller converts to 404)."""
        doc = await self.get(doc_id)
        if doc is None:
            raise KeyError(f"{self.collection}/{doc_id} not found")
        return doc

    # ── Read many ─────────────────────────────────────────────────────────────
    async def list(
        self,
        filters: Optional[List[tuple]] = None,
        order_by: Optional[str] = None,
        order_direction: str = "DESCENDING",
        limit: int = 20,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """
        List documents with optional filters.
        filters: list of (field, op, value) tuples
        """
        query = self._col()
        if filters:
            for field, op, value in filters:
                query = query.where(filter=firestore.FieldFilter(field, op, value))

        # Firestore requires composite indexes for equality filters plus order_by.
        # For MVP-sized per-user lists, avoid those deploy-time footguns and sort
        # after fetching the filtered result set.
        sort_client_side = bool(filters and order_by)
        if order_by and not sort_client_side:
            direction = (
                firestore.Query.DESCENDING
                if order_direction == "DESCENDING"
                else firestore.Query.ASCENDING
            )
            query = query.order_by(order_by, direction=direction)
        if limit and not sort_client_side:
            query = query.limit(limit)
        if offset and not sort_client_side:
            query = query.offset(offset)

        docs = await query.get()
        items = [d.to_dict() for d in docs if d.exists]
        if sort_client_side:
            reverse = order_direction == "DESCENDING"
            items.sort(key=lambda item: item.get(order_by), reverse=reverse)
            if offset:
                items = items[offset:]
            if limit:
                items = items[:limit]
        return items

    # ── Update ────────────────────────────────────────────────────────────────
    async def update(self, doc_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Partially update a document (merge). Returns updated doc."""
        payload = {**data, "updatedAt": now_utc()}
        await self._doc(doc_id).update(payload)
        return await self.get_or_404(doc_id)

    # ── Delete ────────────────────────────────────────────────────────────────
    async def delete(self, doc_id: str) -> None:
        """Hard delete a document."""
        await self._doc(doc_id).delete()

    # ── Count (approximate via list) ──────────────────────────────────────────
    async def count(self, filters: Optional[List[tuple]] = None) -> int:
        """Count documents matching filters (loads all IDs — use carefully)."""
        query = self._col()
        if filters:
            for field, op, value in filters:
                query = query.where(filter=firestore.FieldFilter(field, op, value))
        query = query.select([])  # only fetch document references
        docs = await query.get()
        return len(docs)


# ── Collection-specific repositories ─────────────────────────────────────────
class BooksRepo(FirestoreRepo):
    collection = "books"

    async def list_by_user(
        self,
        user_id: str,
        status: Optional[str] = None,
        search: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        filters = [("userId", "==", user_id)]
        if status:
            filters.append(("status", "==", status))
        docs = await self.list(
            filters=filters, order_by="updatedAt",
            order_direction="DESCENDING", limit=limit, offset=offset,
        )
        # Client-side search (Firestore doesn't support full-text)
        if search:
            s = search.lower()
            docs = [d for d in docs if s in d.get("title", "").lower()]
        return docs

    async def get_chapters(self, book_id: str) -> List[Dict[str, Any]]:
        """Return chapters sub-collection ordered by orderIndex."""
        col = self.db.collection("books").document(book_id).collection("chapters")
        query = col.order_by("orderIndex", direction=firestore.Query.ASCENDING)
        docs = await query.get()
        return [d.to_dict() for d in docs if d.exists]

    async def create_chapter(self, book_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Add a chapter to the book's sub-collection."""
        chapter_id = new_id()
        now = now_utc()
        payload = {**data, "id": chapter_id, "bookId": book_id, "createdAt": now, "updatedAt": now}
        await (
            self.db.collection("books")
            .document(book_id)
            .collection("chapters")
            .document(chapter_id)
            .set(payload)
        )
        return payload

    async def update_chapter(self, book_id: str, chapter_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        ref = (
            self.db.collection("books")
            .document(book_id)
            .collection("chapters")
            .document(chapter_id)
        )
        payload = {**data, "updatedAt": now_utc()}
        await ref.update(payload)
        snap = await ref.get()
        return snap.to_dict()

    async def delete_chapter(self, book_id: str, chapter_id: str) -> None:
        await (
            self.db.collection("books")
            .document(book_id)
            .collection("chapters")
            .document(chapter_id)
            .delete()
        )


class JobsRepo(FirestoreRepo):
    collection = "jobs"

    async def create_job(self, job_type: str, user_id: str, metadata: Dict[str, Any] = {}) -> Dict[str, Any]:
        return await self.create({
            "type": job_type,
            "status": "pending",
            "progress": 0,
            "result": None,
            "error": None,
            "userId": user_id,
            "metadata": metadata,
        })

    async def update_progress(self, job_id: str, progress: int, status: str = "processing") -> None:
        await self.update(job_id, {"progress": progress, "status": status})

    async def complete_job(self, job_id: str, result: Any) -> None:
        await self.update(job_id, {"status": "completed", "progress": 100, "result": result})

    async def fail_job(self, job_id: str, error: str) -> None:
        await self.update(job_id, {"status": "failed", "error": error})


class UsersRepo(FirestoreRepo):
    collection = "users"

    async def get_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        docs = await self.list(
            filters=[("emailLower", "==", email.lower())],
            limit=1,
        )
        return docs[0] if docs else None

    async def create_user(self, data: Dict[str, Any]) -> Dict[str, Any]:
        email_lower = data["email"].lower()
        roles = data.get("roles") or ["user"]
        admin_emails = {
            email.strip().lower()
            for email in settings.admin_emails.split(",")
            if email.strip()
        }
        if email_lower in admin_emails and "admin" not in roles:
            roles = ["admin", *roles]
        payload = {
            **data,
            "emailLower": email_lower,
            "roles": roles,
            "status": data.get("status") or "active",
            "lastLoginAt": None,
        }
        return await self.create(payload)

    async def touch_login(self, user_id: str) -> None:
        await self.update(user_id, {"lastLoginAt": now_utc()})


class RefreshTokensRepo(FirestoreRepo):
    collection = "refreshTokens"

    async def create_token(self, token_hash: str, data: Dict[str, Any]) -> Dict[str, Any]:
        return await self.create(data, doc_id=token_hash)

    async def revoke(self, token_hash: str) -> None:
        await self.update(token_hash, {"revokedAt": now_utc()})


class PasswordResetTokensRepo(FirestoreRepo):
    collection = "passwordResetTokens"

    async def create_token(self, token_hash: str, data: Dict[str, Any]) -> Dict[str, Any]:
        return await self.create(data, doc_id=token_hash)

    async def mark_used(self, token_hash: str) -> None:
        await self.update(token_hash, {"usedAt": now_utc()})


class ProposalsRepo(FirestoreRepo):
    """Propuestas. Al leer, `proposal_status` se normaliza en memoria a los
    códigos de RF-VTA-05 (valores viejos y campo ausente); nunca se reescribe en
    Firestore desde aquí: eso es trabajo de la migración."""

    collection = "proposals"
    audit_collection = "auditLogs"

    @staticmethod
    def _normalize(doc: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if doc is None:
            return None
        raw = doc.get("proposal_status")
        normalized = normalize_proposal_status(raw)
        if normalized not in PROPOSAL_STATUS_VALUES:
            logger.warning(
                "proposals/%s: proposal_status desconocido %r; se deja tal cual (requiere migración)",
                doc.get("id"), raw,
            )
        if normalized != raw:
            doc = {**doc, "proposal_status": normalized}
        return doc

    async def get(self, doc_id: str) -> Optional[Dict[str, Any]]:
        return self._normalize(await super().get(doc_id))

    async def list(self, *args, **kwargs) -> List[Dict[str, Any]]:
        return [self._normalize(doc) for doc in await super().list(*args, **kwargs)]

    @staticmethod
    def plan_status_change(
        proposal: Optional[Dict[str, Any]],
        target: Any,
        *,
        actor_id: str,
        actor_roles: List[str],
        actor_is_admin: bool,
        method: str,
        path: str,
        ip: Optional[str],
        timestamp: str,
        audit_id: str,
        actor_email: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Pura. Lo que la transacción de change_status debe hacer con la propuesta
        leída (sin normalizar). Devuelve {"not_found": True}, {"error": StatusChangeError}
        o {"new_status", "audit_log"} con el registro de auditoría a escribir."""
        if proposal is None:
            return {"not_found": True}
        previous = normalize_proposal_status(proposal.get("proposal_status"))
        owner_id = proposal.get("userId")
        decision = decide_cambio_estado(previous, target, owner_id == actor_id, actor_is_admin)
        if isinstance(decision, StatusChangeError):
            return {"error": decision}
        # RF-VTA-06 (etapa diferida): firmar exige haber adjuntado el documento firmado.
        if decision.value == "firmada" and not proposal.get("signedDocumentPath"):
            return {"error": StatusChangeError(
                422,
                "Debes adjuntar el documento firmado antes de marcar la propuesta como firmada.",
            )}
        return {
            "new_status": decision.value,
            "audit_log": {
                "id": audit_id,
                "action": "proposal_status_changed",
                # RNF-02: mismo esquema que audit_service.record (los campos de abajo son
                # los que consulta el administrador); proposalId/previousStatus/newStatus
                # se conservan por compatibilidad.
                "resourceType": "proposal",
                "resourceId": proposal.get("id"),
                "status": "success",
                "details": {"previousStatus": previous, "newStatus": decision.value},
                "userEmail": actor_email,
                "proposalId": proposal.get("id"),
                "previousStatus": previous,
                "newStatus": decision.value,
                "userId": actor_id,
                "roles": list(actor_roles),
                "ownerId": owner_id,
                "method": method,
                "path": path,
                "ip": ip,
                "timestamp": timestamp,
            },
        }

    async def change_status(
        self,
        proposal_id: str,
        target: Any,
        *,
        actor_id: str,
        actor_roles: List[str],
        actor_is_admin: bool,
        method: str,
        path: str,
        ip: Optional[str],
        actor_email: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Cambia `proposal_status` y escribe su registro de auditoría en una sola
        transacción: si el registro falla, el cambio tampoco se guarda. Devuelve
        {"not_found": True}, {"error": StatusChangeError} o {"proposal": doc}."""
        ref = self._doc(proposal_id)
        audit_id = str(uuid.uuid4())
        audit_ref = self.db.collection(self.audit_collection).document(audit_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            proposal = snap.to_dict() if snap.exists else None
            plan = self.plan_status_change(
                proposal, target,
                actor_id=actor_id, actor_roles=actor_roles, actor_is_admin=actor_is_admin,
                method=method, path=path, ip=ip, actor_email=actor_email,
                # Mismo formato que middleware/audit.py: admin.py ordena por este campo.
                timestamp=datetime.now(timezone.utc).isoformat(),
                audit_id=audit_id,
            )
            if "new_status" not in plan:
                return plan
            updated_at = now_utc()
            # RF-VTA-10: fecha del último paso a cada estado; de ahí sale el tiempo de cierre del reporte.
            txn.update(ref, {
                "proposal_status": plan["new_status"],
                "updatedAt": updated_at,
                f"statusDates.{plan['new_status']}": updated_at,
            })
            txn.set(audit_ref, plan["audit_log"])
            dates = {**(proposal.get("statusDates") or {}), plan["new_status"]: updated_at}
            return {"proposal": {**proposal, "proposal_status": plan["new_status"], "updatedAt": updated_at, "statusDates": dates}}

        return await _txn(transaction)

    # ── RF-VTA-11: historial de versiones ────────────────────────────────────
    # Subcolección proposals/{id}/versions/{versionId}. El contador `versionCounter`
    # y el hash `versionHash` viven en la propuesta y se actualizan en la misma
    # transacción que escribe la versión (sin números duplicados ni lecturas extra).

    # `total_amount` y `totalAmount` son dos grafías del mismo monto que el producto lee por igual
    # (_resolve_total_amount): las dos forman parte de la versión.
    VERSION_FIELDS = ("title", "content", "structured_content", "total_amount", "totalAmount")

    @classmethod
    def version_snapshot(cls, proposal: Dict[str, Any]) -> Dict[str, Any]:
        return {f: proposal.get(f) for f in cls.VERSION_FIELDS}

    @staticmethod
    def _snapshot_hash(snapshot: Dict[str, Any]) -> str:
        raw = json.dumps(snapshot, sort_keys=True, default=str, ensure_ascii=False)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @classmethod
    def version_restore_fields(cls, version: Dict[str, Any]) -> Dict[str, Any]:
        """Campos que restaura una versión. Si la versión guardó el campo vacío (None), restaurar
        también lo vacía: no deja la estructura o el monto nuevos mezclados con el texto viejo. Un
        campo que la versión ni siquiera tiene (versiones del formato anterior) no se toca."""
        return {f: version[f] for f in cls.VERSION_FIELDS if f in version}

    def _versions_col(self, proposal_id: str):
        return self._doc(proposal_id).collection("versions")

    async def delete_versions(self, proposal_id: str) -> int:
        """Borra la subcolección de versiones (Firestore no la borra con el documento). Devuelve cuántas."""
        docs = await self._versions_col(proposal_id).get()
        for start in range(0, len(docs), 400):
            batch = self.db.batch()
            for d in docs[start:start + 400]:
                batch.delete(d.reference)
            await batch.commit()
        return len(docs)

    @staticmethod
    def _legacy_versions(legacy: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
        """Versiones viejas embebidas en el documento (sin id ni autor)."""
        return [
            {**v, "id": f"legacy-{v.get('version', i + 1)}", "source": v.get("source") or "manual"}
            for i, v in enumerate(legacy if isinstance(legacy, list) else [])
            if isinstance(v, dict)
        ]

    async def list_versions(
        self, proposal_id: str, legacy: Optional[List[Dict[str, Any]]] = None
    ) -> List[Dict[str, Any]]:
        """Más recientes primero. Incluye siempre las versiones embebidas anteriores a RF-VTA-11
        (compatibilidad, sin migración obligatoria): al guardar la primera versión nueva las antiguas
        no desaparecen. Sus números son menores porque la numeración nueva continúa tras ellas."""
        docs = await self._versions_col(proposal_id).order_by(
            "version", direction=firestore.Query.DESCENDING
        ).get()
        items = [d.to_dict() for d in docs if d.exists]
        items += self._legacy_versions(legacy)
        return sorted(items, key=lambda v: v.get("version", 0), reverse=True)

    async def get_version(
        self, proposal_id: str, version_id: str, legacy: Optional[List[Dict[str, Any]]] = None
    ) -> Optional[Dict[str, Any]]:
        if version_id.startswith("legacy-"):
            return next((v for v in self._legacy_versions(legacy) if v["id"] == version_id), None)
        snap = await self._versions_col(proposal_id).document(version_id).get()
        return snap.to_dict() if snap.exists else None

    # Guardados simultáneos de la misma propuesta (doble clic, edición + guardado manual): todos leen y
    # actualizan el mismo contador, así que Firestore aborta las transacciones que chocan y, tras 5 intentos,
    # lanza ValueError (RF11-D-011). Se serializan los de este proceso y se reintenta con espera para los
    # de otros procesos.
    VERSION_TXN_ATTEMPTS = 6
    _version_locks: "weakref.WeakValueDictionary[str, asyncio.Lock]" = weakref.WeakValueDictionary()

    async def create_version(self, proposal_id: str, snapshot: Dict[str, Any], **kwargs) -> Optional[Dict[str, Any]]:
        """Guarda un snapshot con el siguiente número de versión (ver `_create_version_once`)."""
        lock = self._version_locks.setdefault(proposal_id, asyncio.Lock())
        async with lock:
            for attempt in range(1, self.VERSION_TXN_ATTEMPTS + 1):
                try:
                    return await self._create_version_once(proposal_id, snapshot, **kwargs)
                except ValueError as exc:
                    if "Failed to commit transaction" not in str(exc) or attempt == self.VERSION_TXN_ATTEMPTS:
                        raise
                    await asyncio.sleep(random.uniform(0.05, 0.25) * attempt)

    async def _create_version_once(
        self,
        proposal_id: str,
        snapshot: Dict[str, Any],
        *,
        author_id: str,
        author_name: Optional[str],
        author_email: Optional[str],
        source: str = "manual",
        label: Optional[str] = None,
        skip_if_unchanged: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Una transacción: guarda un snapshot con el siguiente número de versión. Devuelve la versión,
        o None si la propuesta no existe o (con skip_if_unchanged) el contenido es
        idéntico al de la última versión."""
        ref = self._doc(proposal_id)
        version_id = new_id()
        version_ref = self._versions_col(proposal_id).document(version_id)
        digest = self._snapshot_hash(snapshot)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            if not snap.exists:
                return None
            proposal = snap.to_dict()
            if skip_if_unchanged and proposal.get("versionHash") == digest:
                return None
            counter = proposal.get("versionCounter")
            legacy_count = len(proposal.get("versions") or []) if isinstance(proposal.get("versions"), list) else 0
            number = max(counter if isinstance(counter, int) else 0, legacy_count) + 1
            version = {
                **snapshot,
                "id": version_id,
                "proposalId": proposal_id,
                "version": number,
                "label": label or f"Version {number}",
                "source": source,
                "authorId": author_id,
                "authorName": author_name,
                "authorEmail": author_email,
                "createdAt": now_utc(),
            }
            txn.set(version_ref, version)
            txn.update(ref, {"versionCounter": number, "versionHash": digest})
            return version

        return await _txn(transaction)


class CampaignsRepo(FirestoreRepo):
    collection = "campaigns"


class OpportunitiesRepo(FirestoreRepo):
    collection = "opportunities"


class CustomersRepo(FirestoreRepo):
    collection = "customers"


class TemplatesRepo(FirestoreRepo):
    collection = "templates"


class AssetsRepo(FirestoreRepo):
    collection = "assets"


class SettingsRepo(FirestoreRepo):
    collection = "settings"

    async def get_by_user(self, user_id: str) -> Dict[str, Any]:
        doc = await self.get(user_id)
        return doc or {"userId": user_id, "crm": {}, "llm": {}, "socialConnections": [], "dateFormat": "DD/MM/YYYY"}


class PipelineConfigsRepo(FirestoreRepo):
    """One document per user (doc_id = user_id), like SettingsRepo."""

    collection = "pipeline_configs"

    async def get_by_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        return await self.get(user_id)

    async def upsert_for_user(self, user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        existing = await self.get(user_id)
        if existing:
            return await self.update(user_id, data)
        return await self.create({**data, "userId": user_id}, doc_id=user_id)


def _as_utc(value: Any) -> Optional[datetime]:
    """A stored timestamp as an aware UTC datetime (naive → UTC); None otherwise."""
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


class LeadsRepo(FirestoreRepo):
    """Leads. The contact search of a lead (RF15, Fase 5) is guarded by the
    lead document itself: the search starts inside a Firestore transaction
    that reads and writes `contacts_search`, so two simultaneous clicks are
    serialized and exactly one starts. A search only closes itself if its
    `search_id` is still the lead's (a dead search taken over must not
    overwrite the newer one when it finishes late)."""

    collection = "leads"

    # States after which a new search waits for the cooldown (they may have
    # spent a credit). Errors and "no domain" are not cooled down.
    COOLDOWN_STATES = ("contacts_found", "no_contacts")

    @staticmethod
    def plan_contacts_search_start(
        lead: Optional[Dict[str, Any]], user_id: str, now: datetime, force: bool,
    ) -> Dict[str, Any]:
        """Whether a contact search may start on `lead` now. Pure. Returns
        {"started": bool, "code": None | "lead_not_found" | "forbidden" |
        "search_in_progress" | "lead_not_searchable" | "cooldown",
        "next_search_allowed_at": datetime|None, "stale_search_id": str|None}."""
        def refuse(code: str, **extra: Any) -> Dict[str, Any]:
            return {"started": False, "code": code, "next_search_allowed_at": None, "stale_search_id": None, **extra}

        if lead is None:
            return refuse("lead_not_found")
        if lead.get("user_id") != user_id:
            return refuse("forbidden")
        search = lead.get("contacts_search") or {}
        running = search.get("state") == "running"
        started_at = _as_utc(search.get("started_at"))
        dead_after = timedelta(seconds=CONTACT_SEARCH_CONSIDERED_DEAD_AFTER_SECONDS)
        if running and started_at is not None and now - started_at < dead_after:
            return refuse("search_in_progress")
        if (lead.get("status") or "new") not in CONTACT_SEARCH_SEARCHABLE_STATUSES:
            return refuse("lead_not_searchable")
        searched_at = _as_utc(search.get("searched_at"))
        if not force and search.get("state") in LeadsRepo.COOLDOWN_STATES and searched_at is not None:
            next_allowed = searched_at + timedelta(seconds=CONTACT_SEARCH_COOLDOWN_SECONDS)
            if now < next_allowed:
                return refuse("cooldown", next_search_allowed_at=next_allowed)
        return {
            "started": True,
            "code": None,
            "next_search_allowed_at": None,
            "stale_search_id": search.get("search_id") if running else None,
        }

    @staticmethod
    def contacts_search_start_fields(search_id: str, now: datetime, force: bool) -> Dict[str, Any]:
        return {
            "status": "researching",
            "contacts_search": {"state": "running", "search_id": search_id, "started_at": now, "forced": force},
            "updatedAt": now,
        }

    @staticmethod
    def can_finish_contacts_search(lead: Optional[Dict[str, Any]], search_id: str) -> bool:
        """True while `search_id` is still the lead's running search."""
        search = (lead or {}).get("contacts_search") or {}
        return search.get("state") == "running" and search.get("search_id") == search_id

    async def try_start_contacts_search(
        self, lead_id: str, user_id: str, search_id: str, force: bool, now: datetime,
    ) -> Dict[str, Any]:
        """Atomically mark the lead `researching` with a running search, or
        refuse (see plan_contacts_search_start)."""
        ref = self._doc(lead_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            lead = snap.to_dict() if snap.exists else None
            plan = self.plan_contacts_search_start(lead, user_id, now, force)
            if plan["started"]:
                txn.update(ref, self.contacts_search_start_fields(search_id, now, force))
            return plan

        return await _txn(transaction)

    async def finish_contacts_search(
        self, lead_id: str, search_id: str, status: str, contacts_search: Dict[str, Any], now: datetime,
    ) -> bool:
        """Write the search result and the lead status, only if `search_id`
        is still the lead's running search. Returns whether it wrote."""
        ref = self._doc(lead_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            lead = snap.to_dict() if snap.exists else None
            if not self.can_finish_contacts_search(lead, search_id):
                return False
            txn.update(ref, {"status": status, "contacts_search": contacts_search, "updatedAt": now})
            return True

        return await _txn(transaction)

    # Statuses a contact review may move between; any other (researching: a
    # search is running and will set its own; composing and later stages;
    # error) is never touched by a review.
    REVIEW_RECOMPUTABLE_STATUSES = ("new", "contacts_found")

    @staticmethod
    def plan_status_after_review(
        lead: Optional[Dict[str, Any]], user_id: str, has_active: bool,
    ) -> Optional[str]:
        """The status to write after a contact review, or None to leave the
        lead alone (missing, someone else's, outside REVIEW_RECOMPUTABLE_STATUSES,
        or already right). Pure."""
        if lead is None or lead.get("user_id") != user_id:
            return None
        current = lead.get("status") or "new"
        if current not in LeadsRepo.REVIEW_RECOMPUTABLE_STATUSES:
            return None
        target = "contacts_found" if has_active else "new"
        return None if target == current else target

    async def recompute_status_after_review(
        self, lead_id: str, user_id: str, has_active: bool, now: datetime,
    ) -> Optional[str]:
        """After a contact review: set the lead to contacts_found when it still
        has a non-rejected contact, else new — inside a transaction that re-reads
        the lead, so a search that started meanwhile (status researching) is
        never overwritten. Only status and updatedAt are written, never
        contacts_search. Returns the lead's status afterwards (None if missing)."""
        ref = self._doc(lead_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            lead = snap.to_dict() if snap.exists else None
            if lead is None:
                return None
            target = self.plan_status_after_review(lead, user_id, has_active)
            if target is None:
                return lead.get("status") or "new"
            txn.update(ref, {"status": target, "updatedAt": now})
            return target

        return await _txn(transaction)

    async def list_by_contacts_domain(self, user_id: str, domain: str) -> List[Dict[str, Any]]:
        """The user's leads whose last contact search used `domain`
        (equality on user_id and the nested contacts_search.domain)."""
        return await self.list(
            filters=[("user_id", "==", user_id), ("contacts_search.domain", "==", domain)],
            limit=CONTACT_REUSE_MAX_CANDIDATES,
        )

    # ── Prospecting emails (Agente 3, RF-VTA-16) ──────────────────────────────
    # While an email is written the lead is `composing`; the generation is
    # guarded like the contact search: it starts inside a transaction that
    # reads and writes the lead, and only the generation whose `composing_id`
    # is still the lead's may close it. One stuck for COMPOSING_STALE_SECONDS
    # may be taken over.
    COMPOSING_FIELDS = ("composing_id", "composing_started_at", "composing_previous_status")

    @staticmethod
    def lead_status_from_emails(email_statuses: List[Optional[str]], has_active_contact: bool) -> str:
        """The lead's status summarizing its emails: the most advanced
        non-rejected email wins (sent > approved > pending_review). With none,
        contacts_found while a non-rejected contact remains, else new (RF15
        rule). Pure."""
        statuses = set(email_statuses)
        if "sent" in statuses:
            return "sent"
        if "approved" in statuses:
            return "approved"
        if "pending_review" in statuses:
            return "ready_for_review"
        return "contacts_found" if has_active_contact else "new"

    @staticmethod
    def plan_lead_status_from_emails(
        lead: Optional[Dict[str, Any]], user_id: str, email_statuses: List[Optional[str]], has_active_contact: bool,
    ) -> Optional[str]:
        """The status to write after an email decision, or None to leave the
        lead alone (missing, someone else's, outside
        EMAIL_RECOMPUTABLE_STATUSES, or already right). Pure."""
        if lead is None or lead.get("user_id") != user_id:
            return None
        current = lead.get("status") or "new"
        if current not in EMAIL_RECOMPUTABLE_STATUSES:
            return None
        target = LeadsRepo.lead_status_from_emails(email_statuses, has_active_contact)
        return None if target == current else target

    async def recompute_status_from_emails(
        self, lead_id: str, user_id: str, email_statuses: List[Optional[str]], has_active_contact: bool, now: datetime,
    ) -> Optional[str]:
        """After an email decision: write the lead's summarized status inside
        a transaction that re-reads the lead (a generation or search that
        started meanwhile is never overwritten). Returns the lead's status
        afterwards (None if missing)."""
        ref = self._doc(lead_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            lead = snap.to_dict() if snap.exists else None
            if lead is None:
                return None
            target = self.plan_lead_status_from_emails(lead, user_id, email_statuses, has_active_contact)
            if target is None:
                return lead.get("status") or "new"
            txn.update(ref, {"status": target, "updatedAt": now})
            return target

        return await _txn(transaction)

    @staticmethod
    def plan_compose_start(lead: Optional[Dict[str, Any]], user_id: str, now: datetime) -> Dict[str, Any]:
        """Whether a generation may start on `lead` now. Pure. Returns
        {"started": bool, "code": None | "lead_not_found" | "forbidden" |
        "compose_in_progress" | "lead_not_composable",
        "previous_status": str|None, "stale_compose_id": str|None}.
        A `composing` lead is taken over once its generation is older than
        COMPOSING_STALE_SECONDS, or when it has no start time at all."""
        def refuse(code: str) -> Dict[str, Any]:
            return {"started": False, "code": code, "previous_status": None, "stale_compose_id": None}

        if lead is None:
            return refuse("lead_not_found")
        if lead.get("user_id") != user_id:
            return refuse("forbidden")
        current = lead.get("status") or "new"
        if current == "composing":
            started_at = _as_utc(lead.get("composing_started_at"))
            if started_at is not None and now - started_at < timedelta(seconds=COMPOSING_STALE_SECONDS):
                return refuse("compose_in_progress")
            previous = lead.get("composing_previous_status")
            if previous not in COMPOSE_STARTABLE_STATUSES:
                previous = "contacts_found"
            return {
                "started": True, "code": None, "previous_status": previous,
                "stale_compose_id": lead.get("composing_id"),
            }
        if current not in COMPOSE_STARTABLE_STATUSES:
            return refuse("lead_not_composable")
        return {"started": True, "code": None, "previous_status": current, "stale_compose_id": None}

    @staticmethod
    def compose_start_fields(compose_id: str, now: datetime, previous_status: str) -> Dict[str, Any]:
        return {
            "status": "composing",
            "composing_id": compose_id,
            "composing_started_at": now,
            "composing_previous_status": previous_status,
            "updatedAt": now,
        }

    @staticmethod
    def can_finish_composing(lead: Optional[Dict[str, Any]], compose_id: str) -> bool:
        """True while `compose_id` is still the lead's running generation."""
        return bool(lead) and lead.get("status") == "composing" and lead.get("composing_id") == compose_id

    async def start_composing(self, lead_id: str, user_id: str, compose_id: str, now: datetime) -> Dict[str, Any]:
        """Atomically mark the lead `composing`, or refuse (see plan_compose_start)."""
        ref = self._doc(lead_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            lead = snap.to_dict() if snap.exists else None
            plan = self.plan_compose_start(lead, user_id, now)
            if plan["started"]:
                txn.update(ref, self.compose_start_fields(compose_id, now, plan["previous_status"]))
            return plan

        return await _txn(transaction)

    async def _close_composing(self, lead_id: str, compose_id: str, now: datetime, target_of) -> Optional[str]:
        ref = self._doc(lead_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            lead = snap.to_dict() if snap.exists else None
            if not self.can_finish_composing(lead, compose_id):
                return (lead or {}).get("status")
            target = target_of(lead)
            txn.update(ref, {
                "status": target,
                **{field: firestore.DELETE_FIELD for field in self.COMPOSING_FIELDS},
                "updatedAt": now,
            })
            return target

        return await _txn(transaction)

    async def finish_composing(
        self, lead_id: str, compose_id: str, email_statuses: List[Optional[str]], has_active_contact: bool,
        now: datetime,
    ) -> Optional[str]:
        """After a successful generation: write the summarized status and clear
        the composing fields, only if `compose_id` still owns the lead.
        Returns the lead's status afterwards."""
        return await self._close_composing(
            lead_id, compose_id, now,
            lambda _lead: self.lead_status_from_emails(email_statuses, has_active_contact),
        )

    async def restore_after_compose(self, lead_id: str, compose_id: str, now: datetime) -> Optional[str]:
        """After a failed generation: put back the status the lead had before
        and clear the composing fields, only if `compose_id` still owns it."""
        return await self._close_composing(
            lead_id, compose_id, now,
            lambda lead: lead.get("composing_previous_status") or "contacts_found",
        )


class ContactsRepo(FirestoreRepo):
    collection = "contacts"

    async def list_by_lead(self, lead_id: str, user_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        """A lead's contacts, best match first. Scoped by user_id like leads
        (snake_case field, not the userId of list_by_user)."""
        return await self.list(
            filters=[("user_id", "==", user_id), ("lead_id", "==", lead_id)],
            order_by="confidence_score",
            order_direction="DESCENDING",
            limit=limit,
        )

    async def create_for_lead(
        self, lead_id: str, user_id: str, contact: ContactCreate, extra: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Persist a contact under `lead_id` for `user_id`. Both ids come from
        the caller (session / researched lead) and are written last, so nothing
        in the contact payload can override them.

        The caller must verify beforehand that `lead_id` belongs to `user_id`;
        this method does not check it. `extra` (review status, rank, origin)
        is written over the contact fields but under the two ids."""
        data = contact.model_dump(mode="json")
        return await self.create({**data, **(extra or {}), "lead_id": lead_id, "user_id": user_id})


class OutreachEmailsRepo(FirestoreRepo):
    """Prospecting emails (Agente 3, RF-VTA-16). Scoped by `user_id`
    (snake_case, like leads and contacts). Queries use equality filters only
    and sort in memory, so no composite index is needed."""

    collection = "outreach_emails"

    async def list_by_user(
        self, user_id: str, status: Optional[str] = None, lead_id: Optional[str] = None, limit: int = 500,
    ) -> List[Dict[str, Any]]:
        """The user's emails, newest first; optionally one lead's and/or one
        status (the status is filtered in memory)."""
        filters = [("user_id", "==", user_id)]
        if lead_id:
            filters.append(("lead_id", "==", lead_id))
        items = await self.list(filters=filters, order_by="createdAt", order_direction="DESCENDING", limit=limit)
        items = [item for item in items if item.get("user_id") == user_id]
        if status:
            items = [item for item in items if item.get("status") == status]
        return items

    async def list_by_lead(self, lead_id: str, user_id: str) -> List[Dict[str, Any]]:
        return await self.list_by_user(user_id, lead_id=lead_id, limit=OUTREACH_EMAILS_PER_LEAD_LIMIT)

    async def find_active_for_contact(self, lead_id: str, contact_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """The contact's active email (pending_review / approved), if any."""
        for email in await self.list_by_lead(lead_id, user_id):
            if email.get("contact_id") == contact_id and email.get("status") in ACTIVE_EMAIL_STATUSES:
                return email
        return None

    @staticmethod
    def transition_fields(
        action: str, from_status: Optional[str], to_status: str, user_id: str, user_name: Optional[str],
        now: datetime, extra: Optional[Dict[str, Any]] = None, history_extra: Optional[Dict[str, Any]] = None,
    ) -> tuple:
        """(fields to write, history entry) for one decision. Pure."""
        fields: Dict[str, Any] = {
            **(extra or {}),
            "status": to_status,
            "last_decision_by": user_id,
            "last_decision_at": now,
        }
        prefix = {"approve": "approved", "reject": "rejected", "mark_sent": "sent_marked", "send": "sent"}.get(action)
        if prefix:
            fields[f"{prefix}_by"] = user_id
            fields[f"{prefix}_by_name"] = user_name
            fields["sent_at" if action in ("mark_sent", "send") else f"{prefix}_at"] = now
        if action == "mark_sent":
            fields["send_method"] = "manual"
        elif action == "send":
            fields["send_method"] = "platform"
        entry = {
            "action": action,
            "at": now,
            "by": user_id,
            "by_name": user_name,
            "from_status": from_status,
            "to_status": to_status,
            **(history_extra or {}),
        }
        return fields, entry

    @staticmethod
    def send_lock_stale_after() -> timedelta:
        """Age after which a (not uncertain) send lock is presumed dead: twice
        the longest a claimed send can take (MAIL_SEND_MAX_HTTP_CALLS calls)."""
        return timedelta(
            seconds=float(settings.mail_http_timeout_seconds) * MAIL_SEND_MAX_HTTP_CALLS * SEND_LOCK_STALE_FACTOR,
        )

    @staticmethod
    def _without_deleted(doc: Dict[str, Any]) -> Dict[str, Any]:
        return {k: v for k, v in doc.items() if v is not firestore.DELETE_FIELD}

    async def transition(
        self, email_id: str, user_id: str, user_name: Optional[str], action: str, now: datetime,
        extra: Optional[Dict[str, Any]] = None, history_extra: Optional[Dict[str, Any]] = None,
        expected_from: Optional[str] = None, lock_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Apply `action` inside a transaction that re-reads the email, so two
        decisions at once never both apply. With `expected_from` (the status
        the caller read), a status that changed meanwhile is refused as
        invalid_email_transition and nothing is written. Appends the decision
        to `history`. Returns {"ok", "code", "from_status", "to_status",
        "email"}: `email` is the document after the write (or as read, when
        refused).

        The send lock (plan_send_lock) is checked in the same transaction: a
        send running now refuses mark_sent / reject with send_in_progress; an
        uncertain or stale lock is cleared by them (mark_sent records the last
        send error in its history entry). `send` itself is only recorded by the
        holder of the lock (`lock_id`); otherwise send_state_changed."""
        ref = self._doc(email_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            email = snap.to_dict() if snap.exists else None
            plan = plan_email_transition(email, user_id, action)
            if plan["ok"] and expected_from is not None and plan["from_status"] != expected_from:
                plan = {**plan, "ok": False, "code": "invalid_email_transition", "to_status": None}
            if not plan["ok"]:
                return {**plan, "email": email}
            lock_fields: Dict[str, Any] = {}
            lock_history: Dict[str, Any] = {}
            if action == "send":
                if ((email.get("send_lock") or {}).get("id")) != lock_id or lock_id is None:
                    return {**plan, "ok": False, "code": "send_state_changed", "to_status": None, "email": email}
                lock_fields = {"send_lock": firestore.DELETE_FIELD, "last_send_error": firestore.DELETE_FIELD}
            else:
                lock_plan = plan_send_lock(email, now, action, self.send_lock_stale_after())
                if not lock_plan["ok"]:
                    return {**plan, "ok": False, "code": lock_plan["code"], "to_status": None, "email": email}
                if lock_plan["clear_lock"]:
                    lock_fields = {"send_lock": firestore.DELETE_FIELD}
                last_error = (email.get("last_send_error") or {}).get("code")
                if action in ("mark_sent", "reject") and last_error:
                    lock_history = {"send_error": last_error}
            fields, entry = self.transition_fields(
                action, plan["from_status"], plan["to_status"], user_id, user_name, now,
                {**(extra or {}), **lock_fields}, {**(history_extra or {}), **lock_history},
            )
            txn.update(ref, {**fields, "history": firestore.ArrayUnion([entry]), "updatedAt": now})
            updated = self._without_deleted({
                **email, **fields, "history": [*(email.get("history") or []), entry], "updatedAt": now,
            })
            return {**plan, "email": updated}

        return await _txn(transaction)

    async def claim_send(
        self, email_id: str, user_id: str, lock_id: str, now: datetime, daily_limit: int,
        sender_address: str, sender_display_name: str, force_retry: bool = False,
    ) -> Dict[str, Any]:
        """Take the email's send lock and one slot of today's quota, in one
        transaction that re-reads both (two clicks / two tabs: exactly one
        wins). Refusals: email_not_found, forbidden, invalid_email_transition
        (not approved), send_in_progress / send_uncertain (plan_send_lock),
        daily_limit_reached. Stores the mailbox it is sent from (what «Desde»
        shows afterwards). Returns {"ok", "code", "email", "day"}."""
        ref = self._doc(email_id)
        day = OutreachSendCountersRepo.day_of(now)
        counter_ref = outreach_send_counters_repo._doc(OutreachSendCountersRepo.doc_id_for(user_id, day))
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            email = snap.to_dict() if snap.exists else None
            counter_snap = await counter_ref.get(transaction=txn)
            counter = counter_snap.to_dict() if counter_snap.exists else None

            def refuse(code: str) -> Dict[str, Any]:
                return {"ok": False, "code": code, "email": email, "day": day}

            plan = plan_email_transition(email, user_id, "send")
            if not plan["ok"]:
                return refuse(plan["code"])
            lock_plan = plan_send_lock(email, now, "send", self.send_lock_stale_after(), force_retry)
            if not lock_plan["ok"]:
                return refuse(lock_plan["code"])
            count = int((counter or {}).get("count") or 0)
            if count >= daily_limit:
                return refuse("daily_limit_reached")
            fields = {
                "send_lock": {"id": lock_id, "at": now, "uncertain": False},
                "sender_address": sender_address,
                "sender_display_name": sender_display_name,
                "send_attempts": int(email.get("send_attempts") or 0) + 1,
                "updatedAt": now,
            }
            txn.update(ref, fields)
            txn.set(counter_ref, {
                "id": counter_ref.id, "user_id": user_id, "day": day, "count": count + 1, "updatedAt": now,
            })
            return {"ok": True, "code": None, "email": {**email, **fields}, "day": day}

        return await _txn(transaction)

    async def record_draft(self, email_id: str, lock_id: str, ids: Dict[str, str], now: datetime) -> bool:
        """Store the ids of the draft just created for the email (before it is
        sent), only while `lock_id` still holds its send lock. True if stored."""
        ref = self._doc(email_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            email = snap.to_dict() if snap.exists else None
            if email is None or (email.get("send_lock") or {}).get("id") != lock_id:
                return False
            txn.update(ref, {
                "graph_message_id": ids.get("id") or "",
                "internet_message_id": ids.get("internet_message_id") or "",
                "conversation_id": ids.get("conversation_id") or "",
                "updatedAt": now,
            })
            return True

        return await _txn(transaction)

    async def give_back_slot(self, user_id: str, day: str, now: datetime) -> None:
        """Return one slot of `day`'s quota (a claimed send that sent nothing
        new: it found the email already sent)."""
        counter_ref = outreach_send_counters_repo._doc(OutreachSendCountersRepo.doc_id_for(user_id, day))
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await counter_ref.get(transaction=txn)
            counter = snap.to_dict() if snap.exists else None
            if counter and counter.get("user_id") == user_id:
                txn.update(counter_ref, {"count": max(0, int(counter.get("count") or 0) - 1), "updatedAt": now})

        await _txn(transaction)

    async def release_send(
        self, email_id: str, user_id: str, lock_id: str, now: datetime, error_code: str, uncertain: bool,
        day: str, return_slot: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        """After a failed send, only if `lock_id` still holds the lock: record
        `last_send_error`. A safe failure (nothing was sent) frees the lock and
        gives the quota slot back; an uncertain one keeps the lock, marked
        `uncertain`, and keeps the slot used. `return_slot` overrides the slot
        rule (a forced retry that could not even read the earlier, still
        uncertain attempt: the lock stays uncertain, but this attempt sent
        nothing). Returns the email afterwards."""
        give_back = (not uncertain) if return_slot is None else return_slot
        ref = self._doc(email_id)
        counter_ref = outreach_send_counters_repo._doc(OutreachSendCountersRepo.doc_id_for(user_id, day))
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            email = snap.to_dict() if snap.exists else None
            counter_snap = await counter_ref.get(transaction=txn)
            counter = counter_snap.to_dict() if counter_snap.exists else None
            if email is None or (email.get("send_lock") or {}).get("id") != lock_id:
                return email
            fields: Dict[str, Any] = {"last_send_error": {"code": error_code, "at": now}, "updatedAt": now}
            if uncertain:
                fields["send_lock"] = {**email["send_lock"], "uncertain": True}
            else:
                fields["send_lock"] = firestore.DELETE_FIELD
            txn.update(ref, fields)
            if give_back and counter:
                txn.update(counter_ref, {"count": max(0, int(counter.get("count") or 0) - 1), "updatedAt": now})
            return self._without_deleted({**email, **fields})

        return await _txn(transaction)


def _hashed_id(*parts: str) -> str:
    """A document id from parts that may hold any character (and personal
    data): sha256 of the parts, never the parts themselves."""
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


class OutreachSendCountersRepo(FirestoreRepo):
    """Platform sends per user and UTC day (RF-VTA-16): one document per pair, so
    the daily quota is a single read inside the claim transaction (no range
    query, no index)."""

    collection = "outreach_send_counters"

    @staticmethod
    def day_of(now: datetime) -> str:
        return (now if now.tzinfo else now.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).strftime("%Y-%m-%d")

    @staticmethod
    def doc_id_for(user_id: str, day: str) -> str:
        return _hashed_id("send-counter", user_id, day)

    async def count_for(self, user_id: str, now: datetime) -> int:
        doc = await self.get(self.doc_id_for(user_id, self.day_of(now)))
        if not doc or doc.get("user_id") != user_id:
            return 0
        return int(doc.get("count") or 0)


class DoNotContactRepo(FirestoreRepo):
    """Addresses and domains a user must never email (RF-VTA-16). One
    document per (user, kind, value) with a hashed id, so the check before a
    send is one or two direct reads (no query, no index)."""

    collection = "do_not_contact"

    @staticmethod
    def normalize_email(value: Any) -> str:
        return str(value or "").strip().lower()

    @staticmethod
    def normalize_domain(value: Any) -> str:
        return str(value or "").strip().lower().lstrip("@").rstrip(".")

    @staticmethod
    def doc_id_for(user_id: str, kind: str, value: str) -> str:
        return _hashed_id("do-not-contact", user_id, kind, value)

    async def find_block(self, user_id: str, email: Any) -> Optional[Dict[str, Any]]:
        """The entry blocking `email` (the address itself, or its domain)."""
        address = self.normalize_email(email)
        if not address:
            return None
        candidates = [("email", address)]
        if "@" in address:
            candidates.append(("domain", self.normalize_domain(address.rsplit("@", 1)[1])))
        for kind, value in candidates:
            entry = await self.get(self.doc_id_for(user_id, kind, value))
            if entry and entry.get("user_id") == user_id:
                return entry
        return None

    async def add(
        self, user_id: str, kind: str, value: str, created_by: str, reason: Optional[str] = None,
        source_email_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Add an entry; adding one that exists returns it unchanged."""
        doc_id = self.doc_id_for(user_id, kind, value)
        existing = await self.get(doc_id)
        if existing and existing.get("user_id") == user_id:
            return existing
        return await self.create({
            "user_id": user_id, "kind": kind, "value": value, "reason": reason,
            "source_email_id": source_email_id, "created_by": created_by,
        }, doc_id=doc_id)

    async def list_by_user(self, user_id: str, limit: int = 500) -> List[Dict[str, Any]]:
        items = await self.list(
            filters=[("user_id", "==", user_id)], order_by="createdAt", order_direction="DESCENDING", limit=limit,
        )
        return [item for item in items if item.get("user_id") == user_id]


class MailOAuthStatesRepo(FirestoreRepo):
    """Pending mailbox-connection requests (RF-VTA-16): one per click on
    «Conectar», holding who asked, the PKCE verifier (encrypted) and when it
    expires. The doc id is the sha256 of the OAuth `state`, never the state
    itself. Single use: `consume` marks it used inside a transaction, so two
    callbacks with the same state cannot both get it."""

    collection = "mail_oauth_states"

    @staticmethod
    def doc_id_for(state: str) -> str:
        return _hashed_id("mail-oauth-state", state)

    async def consume(self, state: str, now: datetime) -> Optional[Dict[str, Any]]:
        """The request for `state`, marked used — or None when it does not
        exist, was used already or has expired (an expired one is marked used
        too, so it can never come back)."""
        ref = self._doc(self.doc_id_for(state))
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            doc = snap.to_dict() if snap.exists else None
            if not doc or doc.get("used"):
                return None
            txn.update(ref, {"used": True, "used_at": now, "updatedAt": now})
            expires_at = doc.get("expires_at")
            if expires_at is None or expires_at <= now:
                return None
            return doc

        return await _txn(transaction)


class MailConnectionsRepo(FirestoreRepo):
    """Each user's connected mailbox (RF-VTA-16), doc id = userId: address,
    display name and the OAuth tokens, always encrypted. Apart from
    pipeline_configs on purpose, so GET /pipeline/config can never return a
    token. `token_version` grows on every token change: a refresh only writes
    if nobody else refreshed since it read (`replace_tokens`)."""

    collection = "mail_connections"

    async def save(self, user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Store a fresh connection, replacing any previous one."""
        return await self.create(
            {**data, "user_id": user_id, "token_version": 1, "needs_reconnect": False, "reconnect_reason": None},
            doc_id=user_id,
        )

    async def for_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        doc = await self.get(user_id)
        return doc if doc and doc.get("user_id") == user_id else None

    async def replace_tokens(self, user_id: str, expected_version: int, fields: Dict[str, Any]) -> Dict[str, Any]:
        """Write refreshed tokens only if the connection is still at
        `expected_version`. {"ok": bool, "doc": the connection after the
        write, or as it is now when someone else got there first (None when it
        is gone)}."""
        ref = self._doc(user_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            doc = snap.to_dict() if snap.exists else None
            if not doc or doc.get("user_id") != user_id:
                return {"ok": False, "doc": None}
            if int(doc.get("token_version") or 0) != int(expected_version):
                return {"ok": False, "doc": doc}
            update = {**fields, "token_version": int(expected_version) + 1, "updatedAt": now_utc()}
            txn.update(ref, update)
            return {"ok": True, "doc": {**doc, **update}}

        return await _txn(transaction)

    async def mark_needs_reconnect(self, user_id: str, reason: str) -> None:
        """Flag the connection as unusable until the user connects again
        (only a code is stored as the reason, never a server's text)."""
        ref = self._doc(user_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            doc = snap.to_dict() if snap.exists else None
            if doc and doc.get("user_id") == user_id:
                txn.update(ref, {"needs_reconnect": True, "reconnect_reason": reason, "updatedAt": now_utc()})

        await _txn(transaction)


class PipelineRunsRepo(FirestoreRepo):
    collection = "pipeline_runs"


class KnowledgeDocumentsRepo(FirestoreRepo):
    collection = "knowledge_documents"


class KnowledgeChunksRepo(FirestoreRepo):
    collection = "knowledge_chunks"


class EnablementDraftsRepo(FirestoreRepo):
    collection = "enablement_drafts"


class DuplicateKeyError(Exception):
    """Raised when a unique key (e.g. service name + unit) is already taken."""


class UniqueKeyedRepo(FirestoreRepo):
    """Repo whose documents must be unique under a normalized key.

    For each document there is a key document (`keys_collection/{sha256(key)}`)
    pointing at the owner. Creating or re-keying reads the key document and
    writes both inside one Firestore transaction, so two simultaneous requests
    with the same key cannot both succeed: Firestore retries/aborts the loser,
    which then sees the key as taken."""

    keys_collection: str = ""

    @staticmethod
    def make_key(*parts: str) -> str:
        """Case-insensitive, whitespace-insensitive hash of the key parts."""
        normalized = "".join(" ".join(p.split()).casefold() for p in parts)
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def _key_ref(self, key: str) -> AsyncDocumentReference:
        return self.db.collection(self.keys_collection).document(key)

    async def create_unique(self, data: Dict[str, Any], key: str) -> Dict[str, Any]:
        doc_id = new_id()
        now = now_utc()
        payload = {**data, "id": doc_id, "uniqueKey": key, "createdAt": now, "updatedAt": now}
        doc_ref = self._doc(doc_id)
        key_ref = self._key_ref(key)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            if (await key_ref.get(transaction=txn)).exists:
                raise DuplicateKeyError(key)
            txn.set(key_ref, {"id": key, "ownerId": doc_id})
            txn.set(doc_ref, payload)

        await _txn(transaction)
        return payload

    async def update_unique(
        self, doc_id: str, data: Dict[str, Any], new_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """Partial update; pass `new_key` when a field that feeds the key changed."""
        doc_ref = self._doc(doc_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await doc_ref.get(transaction=txn)
            if not snap.exists:
                raise KeyError(f"{self.collection}/{doc_id} not found")
            current = snap.to_dict()
            payload = {**data, "updatedAt": now_utc()}
            old_key = current.get("uniqueKey")
            if new_key and new_key != old_key:
                new_snap = await self._key_ref(new_key).get(transaction=txn)
                if new_snap.exists and (new_snap.to_dict() or {}).get("ownerId") != doc_id:
                    raise DuplicateKeyError(new_key)
                if old_key:
                    txn.delete(self._key_ref(old_key))
                txn.set(self._key_ref(new_key), {"id": new_key, "ownerId": doc_id})
                payload["uniqueKey"] = new_key
            txn.update(doc_ref, payload)
            return {**current, **payload}

        return await _txn(transaction)


class ServiceCatalogRepo(UniqueKeyedRepo):
    collection = "serviceCatalog"
    keys_collection = "serviceCatalogKeys"


class ServiceTypesRepo(UniqueKeyedRepo):
    collection = "serviceTypes"
    keys_collection = "serviceTypeKeys"


class PipelineRunLocksRepo(FirestoreRepo):
    """One lock document per PipelineConfig (doc id == config id) so two runs
    can never be active on the same config at once. Acquired inside a Firestore
    transaction: two simultaneous POST /pipeline/runs both read and write this
    single document, so Firestore serializes them and exactly one wins.

    A lock is *held* until it is released or its `expiresAt` passes — the TTL
    covers a worker that died without releasing it."""

    collection = "pipeline_run_locks"

    @staticmethod
    def lock_state(lock: Optional[Dict[str, Any]], now: datetime) -> str:
        """"free" (no lock / released), "held", or "stale" (expired without release)."""
        if not lock or lock.get("released"):
            return "free"
        expires_at = lock.get("expiresAt")
        if expires_at is None or expires_at <= now:
            return "stale"
        return "held"

    async def try_acquire(self, config_id: str, run_id: str, ttl_seconds: int) -> Dict[str, Any]:
        """Atomically take the lock. Returns
        {"acquired": bool, "holder_run_id": str|None, "stale_run_id": str|None}:
        `holder_run_id` is the live run that blocked us; `stale_run_id` is an
        expired run whose lock we just took over (caller may mark it failed)."""
        ref = self._doc(config_id)
        transaction = self.db.transaction()

        @firestore.async_transactional
        async def _txn(txn):
            snap = await ref.get(transaction=txn)
            existing = snap.to_dict() if snap.exists else None
            now = now_utc()
            state = self.lock_state(existing, now)
            if state == "held":
                return {"acquired": False, "holder_run_id": existing.get("runId"), "stale_run_id": None}
            txn.set(ref, {
                "id": config_id,
                "runId": run_id,
                "released": False,
                "acquiredAt": now,
                "expiresAt": now + timedelta(seconds=ttl_seconds),
            })
            return {
                "acquired": True,
                "holder_run_id": None,
                "stale_run_id": existing.get("runId") if state == "stale" else None,
            }

        return await _txn(transaction)

    async def release(self, config_id: str, run_id: str) -> None:
        """Release the lock, but only if `run_id` still owns it (a stale run
        finishing late must not free a newer run's lock). Best-effort: the TTL
        is the backstop, so a failure here is logged, never raised."""
        try:
            ref = self._doc(config_id)
            transaction = self.db.transaction()

            @firestore.async_transactional
            async def _txn(txn):
                snap = await ref.get(transaction=txn)
                lock = snap.to_dict() if snap.exists else None
                if lock and lock.get("runId") == run_id and not lock.get("released"):
                    txn.update(ref, {"released": True})

            await _txn(transaction)
        except Exception as exc:  # noqa: BLE001
            logger.warning("pipeline_run_locks: failed to release %s for run %s: %s", config_id, run_id, exc)

    async def get_active_run_id(self, config_id: str) -> Optional[str]:
        """Run id holding a live (not released, not expired) lock, or None."""
        lock = await self.get(config_id)
        if self.lock_state(lock, now_utc()) == "held":
            return lock.get("runId")
        return None


class AuditLogsRepo(FirestoreRepo):
    """RNF-02: registro de auditoría (solo se agrega; la API nunca edita ni borra).

    `timestamp` es un string ISO UTC (no un datetime): así lo escriben el
    middleware y la transacción de cambio de estado, y por eso ordena y filtra
    por rango como texto."""

    collection = "auditLogs"

    async def add(self, log: Dict[str, Any]) -> Dict[str, Any]:
        await self._doc(log["id"]).set(log)
        return log

    async def search(
        self,
        *,
        user_id: Optional[str] = None,
        action: Optional[str] = None,
        resource_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[List[Dict[str, Any]], bool]:
        """Registros más recientes primero. Devuelve (items, has_more).

        Consulta nativa de Firestore (filtros de igualdad + rango y orden por `timestamp`):
        lee solo `offset + limit + 1` documentos. Con filtros de igualdad necesita los
        índices compuestos de `backend/firestore.indexes.json`; si falta alguno
        (FailedPrecondition) se cae al camino lento, que lee TODO el conjunto filtrado en
        cada página (RNF02-D-001: con 1.200 registros eran 1.200 lecturas por petición)."""
        equalities = [
            (field, value)
            for field, value in (
                ("userId", user_id), ("action", action), ("resourceId", resource_id),
            )
            if value
        ]
        query = self._col()
        for field, value in equalities:
            query = query.where(filter=firestore.FieldFilter(field, "==", value))
        native = query
        if date_from:
            native = native.where(filter=firestore.FieldFilter("timestamp", ">=", date_from))
        if date_to:
            native = native.where(filter=firestore.FieldFilter("timestamp", "<=", date_to))
        native = native.order_by("timestamp", direction=firestore.Query.DESCENDING)
        if offset:
            native = native.offset(offset)
        try:
            docs = await native.limit(limit + 1).get()
            page = [d.to_dict() for d in docs if d.exists]
        except FailedPrecondition:
            if not equalities:
                raise   # sin igualdades solo hace falta el índice simple de `timestamp`, que Firestore crea solo
            logger.warning(
                "auditLogs: falta un índice compuesto para %s; se lee todo el conjunto filtrado en cada "
                "página. Despliega backend/firestore.indexes.json.", [f for f, _ in equalities],
            )
            docs = await query.get()
            items = [d.to_dict() for d in docs if d.exists]
            items = [
                item for item in items
                if (not date_from or (item.get("timestamp") or "") >= date_from)
                and (not date_to or (item.get("timestamp") or "") <= date_to)
            ]
            items.sort(key=lambda item: item.get("timestamp") or "", reverse=True)
            page = items[offset: offset + limit + 1]
        return page[:limit], len(page) > limit


# ── Module-level singletons ───────────────────────────────────────────────────
audit_logs_repo = AuditLogsRepo()
books_repo      = BooksRepo()
jobs_repo       = JobsRepo()
users_repo      = UsersRepo()
refresh_tokens_repo = RefreshTokensRepo()
password_reset_tokens_repo = PasswordResetTokensRepo()
proposals_repo  = ProposalsRepo()
campaigns_repo  = CampaignsRepo()
opportunities_repo = OpportunitiesRepo()
customers_repo  = CustomersRepo()
templates_repo  = TemplatesRepo()
assets_repo     = AssetsRepo()
settings_repo   = SettingsRepo()
pipeline_configs_repo = PipelineConfigsRepo()
leads_repo            = LeadsRepo()
contacts_repo         = ContactsRepo()
outreach_emails_repo  = OutreachEmailsRepo()
outreach_send_counters_repo = OutreachSendCountersRepo()
do_not_contact_repo   = DoNotContactRepo()
mail_oauth_states_repo = MailOAuthStatesRepo()
mail_connections_repo  = MailConnectionsRepo()
pipeline_runs_repo    = PipelineRunsRepo()
pipeline_run_locks_repo = PipelineRunLocksRepo()
knowledge_documents_repo = KnowledgeDocumentsRepo()
knowledge_chunks_repo    = KnowledgeChunksRepo()
enablement_drafts_repo   = EnablementDraftsRepo()
service_catalog_repo     = ServiceCatalogRepo()
service_types_repo       = ServiceTypesRepo()
