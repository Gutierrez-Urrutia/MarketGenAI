"""
Supabase Storage service.
"""

from __future__ import annotations

import asyncio
import mimetypes
from typing import Optional

from supabase import create_client, Client

from app.config import settings


_supabase: Optional[Client] = None


def get_supabase() -> Client:
    global _supabase
    if _supabase is None:
        _supabase = create_client(
            settings.supabase_url,
            settings.supabase_service_key,
        )
    return _supabase


BUCKET = settings.supabase_storage_bucket


def _upload_bytes_sync(
    data: bytes,
    storage_path: str,
    content_type: Optional[str] = None,
) -> str:
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


def _upload_file_sync(local_path: str, storage_path: str) -> str:
    with open(local_path, "rb") as f:
        data = f.read()

    content_type, _ = mimetypes.guess_type(local_path)
    return _upload_bytes_sync(data, storage_path, content_type)


def _get_signed_url_sync(storage_path: str, expires_in_seconds: int = 3600) -> str:
    sb = get_supabase()
    response = sb.storage.from_(BUCKET).create_signed_url(
        storage_path,
        expires_in_seconds,
    )
    return response["signedURL"]


def _delete_file_sync(storage_path: str) -> None:
    sb = get_supabase()
    sb.storage.from_(BUCKET).remove([storage_path])


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