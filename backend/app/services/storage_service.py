"""
Almacenamiento de archivos generados (libros, propuestas, assets).

Dos destinos, elegidos con STORAGE_BACKEND: "supabase" (por defecto) o "gcs" (Google Cloud Storage).
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
from pathlib import Path
from typing import Optional

from supabase import create_client, Client

from app.config import settings

logger = logging.getLogger("marketgen.storage")

_supabase: Optional[Client] = None


def get_supabase() -> Client:
    global _supabase
    if _supabase is None:
        if not (settings.supabase_url and settings.supabase_service_key):
            raise RuntimeError(
                "Supabase Storage no está configurado (falta SUPABASE_URL o SUPABASE_SERVICE_KEY)"
            )
        _supabase = create_client(
            settings.supabase_url,
            settings.supabase_service_key,
        )
    return _supabase


BUCKET = settings.supabase_storage_bucket


# ── Google Cloud Storage (STORAGE_BACKEND=gcs) ────────────────────────────────
def _use_gcs() -> bool:
    return (settings.storage_backend or "supabase").strip().lower() == "gcs"


_gcs_client = None


def _gcs_bucket():
    """Bucket de GCS. Usa la identidad de la plataforma (Cloud Run o la VM), sin archivo de clave."""
    global _gcs_client
    if not settings.gcs_bucket:
        raise RuntimeError("STORAGE_BACKEND=gcs pero falta GCS_BUCKET")
    if _gcs_client is None:
        from google.cloud import storage

        _gcs_client = storage.Client(project=settings.google_cloud_project or None)
    return _gcs_client.bucket(settings.gcs_bucket)


def _gcs_upload_bytes(data: bytes, storage_path: str, content_type: Optional[str]) -> str:
    if content_type is None:
        mime, _ = mimetypes.guess_type(storage_path)
        content_type = mime or "application/octet-stream"
    _gcs_bucket().blob(storage_path).upload_from_string(data, content_type=content_type)
    return _gcs_signed_url(storage_path, 3600)


def _gcs_signed_url(storage_path: str, expires_in_seconds: int) -> str:
    """URL firmada V4 con vencimiento. Firma por la API IAM con la cuenta de servicio de la plataforma
    (necesita el rol Service Account Token Creator sobre sí misma)."""
    from datetime import timedelta

    import google.auth
    from google.auth.transport.requests import Request

    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    credentials.refresh(Request())
    return _gcs_bucket().blob(storage_path).generate_signed_url(
        version="v4",
        expiration=timedelta(seconds=expires_in_seconds),
        method="GET",
        service_account_email=credentials.service_account_email,
        access_token=credentials.token,
    )


def _gcs_delete(storage_path: str) -> None:
    from google.api_core.exceptions import NotFound

    try:
        _gcs_bucket().blob(storage_path).delete()
    except NotFound:
        pass


def _upload_bytes_sync(
    data: bytes,
    storage_path: str,
    content_type: Optional[str] = None,
) -> str:
    if _use_gcs():
        return _gcs_upload_bytes(data, storage_path, content_type)
    try:
        sb = get_supabase()
        if content_type is None:
            mime, _ = mimetypes.guess_type(storage_path)
            content_type = mime or "application/octet-stream"

        sb.storage.from_(BUCKET).upload(
            path=storage_path,
            file=data,
            file_options={"content-type": content_type, "upsert": "true"},
        )

        return sb.storage.from_(BUCKET).get_public_url(storage_path)
    except Exception as exc:
        logger.warning(
            "⚠️ [Storage] Fallo al subir a Supabase (%s). Guardando archivo localmente en 'generated_files/%s'",
            exc,
            storage_path,
        )
        local_dest = Path("generated_files") / storage_path
        local_dest.parent.mkdir(parents=True, exist_ok=True)
        local_dest.write_bytes(data)
        return f"/api/v1/assets/local/{storage_path}"


def _upload_file_sync(local_path: str, storage_path: str) -> str:
    with open(local_path, "rb") as f:
        data = f.read()

    content_type, _ = mimetypes.guess_type(local_path)
    return _upload_bytes_sync(data, storage_path, content_type)


def _get_signed_url_sync(storage_path: str, expires_in_seconds: int = 3600) -> str:
    if _use_gcs():
        return _gcs_signed_url(storage_path, expires_in_seconds)
    try:
        sb = get_supabase()
        response = sb.storage.from_(BUCKET).create_signed_url(
            storage_path,
            expires_in_seconds,
        )
        if isinstance(response, dict) and "signedURL" in response:
            return response["signedURL"]
        return f"/api/v1/assets/local/{storage_path}"
    except Exception as exc:
        logger.warning(
            "⚠️ [Storage] Fallo al obtener URL firmada de Supabase (%s). Usando fallback local para '%s'",
            exc,
            storage_path,
        )
        return f"/api/v1/assets/local/{storage_path}"


def _delete_file_sync(storage_path: str) -> None:
    if _use_gcs():
        _gcs_delete(storage_path)
        return
    try:
        sb = get_supabase()
        sb.storage.from_(BUCKET).remove([storage_path])
    except Exception:
        pass
    local_dest = Path("generated_files") / storage_path
    if local_dest.exists():
        local_dest.unlink()



def book_export_path(book_id: str, filename: str) -> str:
    return f"books/{book_id}/exports/{filename}"


def proposal_path(proposal_id: str, filename: str) -> str:
    return f"proposals/{proposal_id}/{filename}"


def asset_path(asset_id: str, extension: str) -> str:
    return f"assets/{asset_id}.{extension}"


def image_path(asset_id: str) -> str:
    return f"images/{asset_id}.png"


class StorageService:
    async def upload_bytes(
        self,
        data: bytes,
        storage_path: str,
        content_type: Optional[str] = None,
    ) -> str:
        return await asyncio.to_thread(_upload_bytes_sync, data, storage_path, content_type)

    async def upload_file(self, local_path: str, storage_path: str) -> str:
        return await asyncio.to_thread(_upload_file_sync, local_path, storage_path)

    async def get_signed_url(
        self,
        storage_path: str,
        expires_in_seconds: int = 3600,
    ) -> str:
        return await asyncio.to_thread(_get_signed_url_sync, storage_path, expires_in_seconds)

    async def delete_file(self, storage_path: str) -> None:
        await asyncio.to_thread(_delete_file_sync, storage_path)

    def book_export_path(self, book_id: str, filename: str) -> str:
        return book_export_path(book_id, filename)

    def proposal_path(self, proposal_id: str, filename: str) -> str:
        return proposal_path(proposal_id, filename)

    def asset_path(self, asset_id: str, extension: str) -> str:
        return asset_path(asset_id, extension)

    def image_path(self, asset_id: str) -> str:
        return image_path(asset_id)


storage_service = StorageService()