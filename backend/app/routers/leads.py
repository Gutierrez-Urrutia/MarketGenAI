"""Leads router (Fase 2 — Agente 1 output).

Read-only for this phase: GET /leads (list, filtered) and GET /leads/{id}.
Override (PUT), discard (DELETE), and re-running Agente 2/3 on a lead
(`POST /leads/{id}/research` / `/compose`) belong to Fase 3/4 — not here.
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.lead import Lead, LeadListResponse, LeadStatus
from app.services.firestore_service import leads_repo

router = APIRouter(prefix="/leads", tags=["Leads"])


def _assert_owner(lead: dict, user_id: str) -> None:
    if lead.get("user_id") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")


async def _get_lead_for_user(lead_id: str, user_id: str) -> dict:
    try:
        lead = await leads_repo.get_or_404(lead_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Lead '{lead_id}' not found.",
        )
    _assert_owner(lead, user_id)
    return lead


@router.get("", response_model=LeadListResponse)
async def list_leads(
    status_filter: Optional[LeadStatus] = Query(None, alias="status"),
    min_score: Optional[float] = Query(None, ge=0.0, le=1.0),
    source_id: Optional[str] = Query(None),
    pipeline_config_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user: CurrentUser = Depends(get_current_user),
):
    filters = [("user_id", "==", user.sub)]
    if status_filter:
        filters.append(("status", "==", status_filter.value))
    if source_id:
        filters.append(("source_id", "==", source_id))
    if pipeline_config_id:
        filters.append(("pipeline_config_id", "==", pipeline_config_id))

    leads = await leads_repo.list(
        filters=filters,
        order_by="createdAt",
        order_direction="DESCENDING",
        limit=limit,
    )
    if min_score is not None:
        leads = [lead for lead in leads if (lead.get("relevance_score") or 0.0) >= min_score]

    return LeadListResponse(items=leads, total=len(leads))


@router.get("/{lead_id}", response_model=Lead)
async def get_lead(lead_id: str, user: CurrentUser = Depends(get_current_user)):
    return await _get_lead_for_user(lead_id, user.sub)
