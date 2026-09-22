"""Pipeline router — Fase 1 (infraestructura): CRUD de PipelineConfig only.

Agentes 1/2/3, orquestador, leads/contacts/outreach_emails endpoints and the
scheduled scan task are out of scope here (Fases 2-6 of
plan-pipeline-3-agentes.md).

One PipelineConfig document per user (doc_id == user.sub), same pattern as
SettingsRepo. smtp_password is write-only: it is encrypted with
app.services.encryption_service before being persisted as
`smtp_password_encrypted`, and the API never returns it — only a
`smtp_password_configured` boolean so the frontend can show "configured"
without ever getting the secret back.
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.pipeline import (
    SOURCE_TYPE_REQUIRED_CONFIG_FIELDS,
    JobSourceCreate,
    JobSourceUpdate,
    PipelineConfigUpdate,
    PipelineKeywordsUpdate,
    SourceType,
)
from app.services import encryption_service
from app.services.firestore_service import new_id, pipeline_configs_repo

router = APIRouter(prefix="/pipeline", tags=["Pipeline"])


def _default_config() -> Dict[str, Any]:
    return {
        "keywords": [],
        "industries": [],
        "excluded_companies": [],
        "sources": [],
        "smtp_host": "",
        "smtp_port": 587,
        "smtp_user": "",
        "sender_email": "",
        "sender_name": "",
        "auto_send_threshold": 0.80,
        "max_emails_per_day": 50,
        "scan_frequency_hours": 24,
        "is_active": True,
    }


def _to_public(doc: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Strip secrets, add a userId, and never leak smtp_password_encrypted."""
    base = _default_config()
    public = {**base, **doc}
    public["userId"] = user_id
    public["smtp_password_configured"] = bool(public.get("smtp_password_encrypted"))
    public.pop("smtp_password_encrypted", None)
    public.pop("smtp_password", None)
    return public


async def _get_or_create_doc(user_id: str) -> Dict[str, Any]:
    doc = await pipeline_configs_repo.get_by_user(user_id)
    if doc is None:
        doc = await pipeline_configs_repo.upsert_for_user(user_id, _default_config())
    return doc


def _find_source(sources: List[Dict[str, Any]], source_id: str) -> Dict[str, Any]:
    for source in sources:
        if source.get("id") == source_id:
            return source
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Source '{source_id}' not found.",
    )


@router.get("/config")
async def get_config(user: CurrentUser = Depends(get_current_user)):
    doc = await pipeline_configs_repo.get_by_user(user.sub)
    return _to_public(doc or {}, user.sub)


@router.put("/config")
async def update_config(
    body: PipelineConfigUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    payload = body.model_dump(exclude_unset=True, exclude={"smtp_password"})

    if body.smtp_password is not None:
        if body.smtp_password.strip():
            try:
                payload["smtp_password_encrypted"] = encryption_service.encrypt(body.smtp_password)
            except encryption_service.EncryptionNotConfiguredError as exc:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=str(exc),
                ) from exc
        else:
            # Explicit empty string clears a previously configured password.
            payload["smtp_password_encrypted"] = ""

    await _get_or_create_doc(user.sub)
    doc = await pipeline_configs_repo.upsert_for_user(user.sub, payload)
    return _to_public(doc, user.sub)


@router.put("/config/keywords")
async def update_keywords(
    body: PipelineKeywordsUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    await _get_or_create_doc(user.sub)
    doc = await pipeline_configs_repo.upsert_for_user(user.sub, body.model_dump())
    return _to_public(doc, user.sub)


@router.post("/config/sources", status_code=status.HTTP_201_CREATED)
async def create_source(
    body: JobSourceCreate,
    user: CurrentUser = Depends(get_current_user),
):
    doc = await _get_or_create_doc(user.sub)
    sources = list(doc.get("sources") or [])
    new_source = {
        "id": new_id(),
        "name": body.name,
        "source_type": body.source_type.value,
        "enabled": body.enabled,
        "config": body.config,
        "rate_limit": body.rate_limit,
        "last_fetched_at": None,
    }
    sources.append(new_source)
    doc = await pipeline_configs_repo.upsert_for_user(user.sub, {"sources": sources})
    return _to_public(doc, user.sub)


@router.put("/config/sources/{source_id}")
async def update_source(
    source_id: str,
    body: JobSourceUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    doc = await _get_or_create_doc(user.sub)
    sources = list(doc.get("sources") or [])
    source = _find_source(sources, source_id)

    updates = body.model_dump(exclude_unset=True)
    if "source_type" in updates and updates["source_type"] is not None:
        updates["source_type"] = updates["source_type"].value
    source.update(updates)

    doc = await pipeline_configs_repo.upsert_for_user(user.sub, {"sources": sources})
    return _to_public(doc, user.sub)


@router.delete("/config/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source(
    source_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    doc = await _get_or_create_doc(user.sub)
    sources = list(doc.get("sources") or [])
    _find_source(sources, source_id)  # 404 if missing
    sources = [source for source in sources if source.get("id") != source_id]
    await pipeline_configs_repo.upsert_for_user(user.sub, {"sources": sources})


@router.post("/config/sources/{source_id}/test")
async def test_source(
    source_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Validate the source has the config fields its source_type needs.

    This is a static shape check only — no external call is made yet. Real
    connectivity checks (hit the API/RSS feed/scraper URL) land in Fase 2
    alongside JobScoutService.
    """
    doc = await _get_or_create_doc(user.sub)
    sources = list(doc.get("sources") or [])
    source = _find_source(sources, source_id)

    source_type = SourceType(source["source_type"])
    required_fields = SOURCE_TYPE_REQUIRED_CONFIG_FIELDS.get(source_type, [])
    config = source.get("config") or {}
    missing_fields = [
        field for field in required_fields
        if not str(config.get(field, "")).strip()
    ]

    if missing_fields:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "message": f"Source '{source['name']}' is missing required config fields.",
                "missing_fields": missing_fields,
            },
        )

    return {"ok": True, "message": f"Source '{source['name']}' has all required fields for {source_type.value}."}
