"""Pipeline router — Fase 1 (PipelineConfig CRUD) + Fase 2 (manual Agente 1 trigger).

Agentes 2/3, el orquestador, y los endpoints de contacts/outreach_emails
siguen fuera de alcance (Fases 3-6 de plan-pipeline-3-agentes.md). El
escaneo programado (Celery Beat / Vercel Cron) tampoco está — Fase 5-6,
condicionada al plan de Vercel que confirme el cliente (ver
analisis-worker-serverless.md). `POST /pipeline/runs` es la única forma de
disparar un escaneo: siempre manual, a pedido de quien lo llame.

One PipelineConfig document per user (doc_id == user.sub), same pattern as
SettingsRepo. smtp_password is write-only: it is encrypted with
app.services.encryption_service before being persisted as
`smtp_password_encrypted`, and the API never returns it — only a
`smtp_password_configured` boolean so the frontend can show "configured"
without ever getting the secret back.
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.job import JobAccepted
from app.schemas.pipeline import (
    SOURCE_TYPE_REQUIRED_CONFIG_FIELDS,
    SOURCE_TYPE_SECRET_CONFIG_FIELDS,
    JobSourceCreate,
    JobSourceUpdate,
    PipelineConfigUpdate,
    PipelineKeywordsUpdate,
    PipelineRunStatus,
    SourceType,
)
from app.services import encryption_service, job_scout_service
from app.services.firestore_service import new_id, now_utc, pipeline_configs_repo, pipeline_runs_repo
from app.workers.tasks.pipeline_tasks import task_run_job_scout

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


def _split_source_config(
    source_type: SourceType, config: Dict[str, Any]
) -> tuple[Dict[str, Any], Dict[str, str]]:
    """Split a source's config into (plaintext, encrypted) halves.

    Fields listed in SOURCE_TYPE_SECRET_CONFIG_FIELDS for this source_type
    (e.g. `api_key` for source_type=api) are encrypted with Fernet and moved
    out of the plaintext config — same treatment as
    PipelineConfig.smtp_password. Everything else stays in plaintext (e.g.
    `base_url`, `feed_url`, scraper selectors — not secrets).
    """
    secret_fields = set(SOURCE_TYPE_SECRET_CONFIG_FIELDS.get(source_type, []))
    plaintext: Dict[str, Any] = {}
    encrypted: Dict[str, str] = {}
    for key, value in (config or {}).items():
        if key in secret_fields:
            if value:
                try:
                    encrypted[key] = encryption_service.encrypt(str(value))
                except encryption_service.EncryptionNotConfiguredError as exc:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=str(exc),
                    ) from exc
        else:
            plaintext[key] = value
    return plaintext, encrypted


def _public_source(source: Dict[str, Any]) -> Dict[str, Any]:
    """Strip encrypted secret values; expose only which secret fields are set."""
    public = {k: v for k, v in source.items() if k != "config_encrypted"}
    encrypted = source.get("config_encrypted") or {}
    public["configured_secret_fields"] = sorted(encrypted.keys())
    return public


def _to_public(doc: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Strip secrets, add a userId, and never leak smtp_password_encrypted."""
    base = _default_config()
    public = {**base, **doc}
    public["userId"] = user_id
    public["smtp_password_configured"] = bool(public.get("smtp_password_encrypted"))
    public.pop("smtp_password_encrypted", None)
    public.pop("smtp_password", None)
    public["sources"] = [_public_source(s) for s in public.get("sources") or []]
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
        # smtp_password is never stripped (its own spaces can be meaningful),
        # but a whitespace-only value is not a real password: treat it as
        # "not provided" and keep whatever is already stored. Only a true
        # empty string ("") is an explicit request to clear it.
        if body.smtp_password.strip():
            try:
                payload["smtp_password_encrypted"] = encryption_service.encrypt(body.smtp_password)
            except encryption_service.EncryptionNotConfiguredError as exc:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=str(exc),
                ) from exc
        elif body.smtp_password == "":
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
    plaintext_config, encrypted_config = _split_source_config(body.source_type, body.config)
    new_source = {
        "id": new_id(),
        "name": body.name,
        "source_type": body.source_type.value,
        "enabled": body.enabled,
        "config": plaintext_config,
        "config_encrypted": encrypted_config,
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
    if "config" in updates and updates["config"] is not None:
        effective_type = SourceType(updates.get("source_type", source["source_type"]))
        plaintext_config, encrypted_config = _split_source_config(effective_type, updates["config"])
        updates["config"] = plaintext_config
        updates["config_encrypted"] = encrypted_config
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

    This is a static shape check only — no external call is made. A real
    connectivity check happens when the source is actually scanned, as part
    of a run (POST /pipeline/runs → JobScoutService).
    """
    doc = await _get_or_create_doc(user.sub)
    sources = list(doc.get("sources") or [])
    source = _find_source(sources, source_id)

    source_type = SourceType(source["source_type"])
    required_fields = SOURCE_TYPE_REQUIRED_CONFIG_FIELDS.get(source_type, [])
    config = source.get("config") or {}
    encrypted_config = source.get("config_encrypted") or {}
    missing_fields = [
        field for field in required_fields
        if not str(config.get(field, "")).strip() and not encrypted_config.get(field)
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


# ── Pipeline runs (Fase 2 — Agente 1 only, always manual) ──────────────────
async def _run_job_scout_now(run_id: str, config: Dict[str, Any]) -> None:
    try:
        result = await job_scout_service.scan_all_sources(config, run_id)
    except Exception as exc:
        await job_scout_service.fail_run(run_id, str(exc))
        raise
    await job_scout_service.finalize_run(run_id, result)


@router.post("/runs", status_code=status.HTTP_202_ACCEPTED, response_model=JobAccepted)
async def create_run(user: CurrentUser = Depends(get_current_user)):
    """Trigger a manual scan (Agente 1 only) for the caller's PipelineConfig.

    Always explicit — there is no scheduled/automatic trigger in this
    phase. Tries Celery first; if the broker is unreachable, falls back to
    running synchronously in this request, same pattern as
    routers/books.py.
    """
    config = await _get_or_create_doc(user.sub)
    if not any(source.get("enabled") for source in (config.get("sources") or [])):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No enabled sources configured for this pipeline.",
        )

    run = await pipeline_runs_repo.create({
        "pipeline_config_id": config["id"],
        "user_id": user.sub,
        "status": PipelineRunStatus.RUNNING.value,
        "leads_found": 0,
        "leads_new": 0,
        "contacts_found": 0,
        "emails_generated": 0,
        "emails_auto_approved": 0,
        "emails_pending_review": 0,
        "emails_sent": 0,
        "started_at": now_utc(),
        "agent1_completed_at": None,
        "agent2_completed_at": None,
        "agent3_completed_at": None,
        "completed_at": None,
        "errors": [],
    })

    try:
        task_run_job_scout.delay(run["id"], config)
    except Exception:
        # Redis/Celery no disponible — ejecutar síncronamente
        await _run_job_scout_now(run["id"], config)

    return JobAccepted(job_id=run["id"])


@router.get("/runs")
async def list_runs(
    limit: int = Query(20, ge=1, le=100),
    user: CurrentUser = Depends(get_current_user),
):
    runs = await pipeline_runs_repo.list(
        filters=[("user_id", "==", user.sub)],
        order_by="createdAt",
        order_direction="DESCENDING",
        limit=limit,
    )
    return {"items": runs, "total": len(runs)}


def _assert_run_owner(run: Dict[str, Any], user_id: str) -> None:
    if run.get("user_id") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")


@router.get("/runs/{run_id}")
async def get_run(run_id: str, user: CurrentUser = Depends(get_current_user)):
    try:
        run = await pipeline_runs_repo.get_or_404(run_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Run '{run_id}' not found.",
        )
    _assert_run_owner(run, user.sub)
    return run
