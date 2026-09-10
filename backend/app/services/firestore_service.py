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
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from google.oauth2 import service_account
from google.cloud import firestore
from google.cloud.firestore_v1.async_client import AsyncClient
from google.cloud.firestore_v1 import AsyncDocumentReference

from app.config import settings

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
            try:
                raw_json = settings.firebase_service_account_json.strip()
                sa_info = json.loads(raw_json)
                credentials = service_account.Credentials.from_service_account_info(sa_info)
                logger.info(
                    "✅ [Firestore] Credenciales cargadas exitosamente desde FIREBASE_SERVICE_ACCOUNT_JSON (project='%s', email='%s')",
                    sa_info.get("project_id"),
                    sa_info.get("client_email"),
                )
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
    collection = "proposals"


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


# ── Module-level singletons ───────────────────────────────────────────────────
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
