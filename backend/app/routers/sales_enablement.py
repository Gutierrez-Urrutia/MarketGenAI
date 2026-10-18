"""
Sales enablement (RF-VTA-08).

Endpoints:
  POST   /sales-enablement/drafts/generate   — genera y guarda un borrador (caso de éxito, comparativa u objeción)
  GET    /sales-enablement/drafts            — lista los borradores del usuario (?type=)
  GET    /sales-enablement/drafts/{id}       — un borrador
  PUT    /sales-enablement/drafts/{id}       — edita título o contenido
  POST   /sales-enablement/drafts/{id}/export — descarga el borrador en Word (.docx), con el texto editado si se envía
  DELETE /sales-enablement/drafts/{id}       — elimina

Todo se limita al usuario autenticado. El borrador se basa solo en su base de conocimiento.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response, status

from app.core.rate_limit import limiter
from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.enablement import (
    EnablementDraftOut,
    EnablementDraftUpdate,
    EnablementGenerateRequest,
    EnablementType,
)
from app.services import enablement_service
from app.services.firestore_service import enablement_drafts_repo, opportunities_repo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sales-enablement", tags=["Sales enablement"])

MAX_DRAFTS_LIST = 200

NO_SOURCES_MESSAGE = (
    "No hay información cargada que respalde este material. Sube propuestas o documentos "
    "relacionados en la base de conocimiento e inténtalo de nuevo."
)


async def _get_draft_for_user(draft_id: str, user_id: str) -> dict:
    draft = await enablement_drafts_repo.get(draft_id)
    if not draft:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Borrador no encontrado.")
    if draft.get("userId") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")
    return draft


async def _client_from_opportunity(opportunity_id: str, user_id: str) -> str:
    opportunity = await opportunities_repo.get(opportunity_id)
    if not opportunity:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Oportunidad no encontrada.")
    if opportunity.get("userId") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")
    return str(opportunity.get("company") or "")


@router.post("/drafts/generate", response_model=EnablementDraftOut, status_code=status.HTTP_201_CREATED)
@limiter.limit("20/minute")
async def generate_draft(
    request: Request,
    body: EnablementGenerateRequest,
    user: CurrentUser = Depends(get_current_user),
):
    client_name = (body.clientName or "").strip()
    if body.opportunityId:
        client_name = client_name or await _client_from_opportunity(body.opportunityId, user.sub)

    try:
        result = await enablement_service.generate_draft(
            user_id=user.sub,
            kind=body.type,
            topic=body.topic.strip(),
            client_name=client_name,
            language=body.language,
            instructions=body.instructions,
        )
    except enablement_service.NoSourcesError:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=NO_SOURCES_MESSAGE)
    except Exception:
        logger.exception("enablement generation failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="No se pudo generar el borrador. Inténtalo de nuevo.")

    return await enablement_drafts_repo.create({
        "type": body.type,
        "topic": body.topic.strip(),
        "clientName": client_name,
        "opportunityId": body.opportunityId,
        "language": body.language,
        "userId": user.sub,
        **result,
    })


@router.get("/drafts", response_model=list[EnablementDraftOut])
async def list_drafts(
    type: Optional[EnablementType] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    filters = [("userId", "==", user.sub)]
    if type:
        filters.append(("type", "==", type))
    return await enablement_drafts_repo.list(
        filters=filters, order_by="createdAt", order_direction="DESCENDING", limit=MAX_DRAFTS_LIST,
    )


@router.get("/drafts/{draft_id}", response_model=EnablementDraftOut)
async def get_draft(draft_id: str, user: CurrentUser = Depends(get_current_user)):
    return await _get_draft_for_user(draft_id, user.sub)


@router.put("/drafts/{draft_id}", response_model=EnablementDraftOut)
async def update_draft(
    draft_id: str,
    body: EnablementDraftUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    await _get_draft_for_user(draft_id, user.sub)
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Nada que actualizar.")
    return await enablement_drafts_repo.update(draft_id, changes)


@router.post("/drafts/{draft_id}/export")
async def export_draft(
    draft_id: str,
    content: Optional[str] = Body(None, embed=True, max_length=20000),
    user: CurrentUser = Depends(get_current_user),
):
    draft = await _get_draft_for_user(draft_id, user.sub)
    data = enablement_service.build_docx(draft, content)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": 'attachment; filename="borrador-comercial.docx"'},
    )


@router.delete("/drafts/{draft_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_draft(draft_id: str, user: CurrentUser = Depends(get_current_user)):
    await _get_draft_for_user(draft_id, user.sub)
    await enablement_drafts_repo.delete(draft_id)
