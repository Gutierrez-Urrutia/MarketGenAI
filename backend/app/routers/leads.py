"""Leads router (Fase 2 — Agente 1 output; RF15 — Agente 2 contacts).

GET /leads (list, filtered) and GET /leads/{id}; the contact search of one
lead (POST /leads/{id}/contacts/search), its contacts
(GET /leads/{id}/contacts) and their review
(PATCH /leads/{id}/contacts/{contact_id}/review). Every route checks that
the lead is the caller's: 404 when it does not exist, 403 when it is
someone else's. Override (PUT), discard (DELETE) and Agente 3 (`/compose`)
are not here.
"""
# No `from __future__ import annotations` here: @limiter.limit wraps the
# endpoint, and FastAPI could not resolve a string annotation of the body
# model (ContactSearchRequest) through the wrapper — same as routers/pipeline.py.
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status

from app.core.pipeline_constants import CONTACT_SEARCH_RATE_LIMIT
from app.core.rate_limit import limiter
from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.contact import (
    Contact,
    ContactListResponse,
    ContactReviewRequest,
    ContactReviewResponse,
    ContactSearchRequest,
    ContactSearchResponse,
)
from app.schemas.lead import Lead, LeadListResponse, LeadStatus
from app.services import contact_research_service
from app.services.contact_research_service import ContactSearchRefused, review_allowed, review_status_of
from app.services.firestore_service import contacts_repo, leads_repo, now_utc

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


# ── Contacts of a lead (Agente 2, RF15) ───────────────────────────────────────
@router.post("/{lead_id}/contacts/search", response_model=ContactSearchResponse)
@limiter.limit(CONTACT_SEARCH_RATE_LIMIT)
async def search_lead_contacts(
    request: Request,
    lead_id: str,
    body: Optional[ContactSearchRequest] = Body(None),
    user: CurrentUser = Depends(get_current_user),
):
    """Search the contacts of one lead now (manual, synchronous). Refusals:
    409 search_in_progress / cooldown / reuse_area_mismatch /
    search_superseded, 422 lead_not_searchable / hunter_not_configured.
    A provider failure is not an HTTP error: the result has state=error and
    a `reason` code."""
    lead = await _get_lead_for_user(lead_id, user.sub)
    try:
        return await contact_research_service.get_service().research_lead(
            lead, user.sub, force=bool(body and body.force),
        )
    except ContactSearchRefused as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.get("/{lead_id}/contacts", response_model=ContactListResponse)
async def list_lead_contacts(
    lead_id: str,
    include_rejected: bool = Query(False),
    user: CurrentUser = Depends(get_current_user),
):
    """The lead's contacts: ranked ones first (rank 1..3), then by confidence."""
    await _get_lead_for_user(lead_id, user.sub)
    items = await contact_research_service.get_service().list_contacts(lead_id, user.sub, include_rejected)
    return ContactListResponse(items=items, total=len(items))


@router.patch("/{lead_id}/contacts/{contact_id}/review", response_model=ContactReviewResponse)
async def review_lead_contact(
    lead_id: str,
    contact_id: str,
    body: ContactReviewRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Approve or reject one contact of the lead. Reject from not_required,
    pending or approved; approve from pending or rejected (restores a
    rejection). 404 when the contact is not this lead's / user's; 422 for
    any other transition. Afterwards the lead's status is recomputed from its
    non-rejected contacts (only while it is new / contacts_found) and returned
    as `lead_status`; contacts_search is never touched."""
    await _get_lead_for_user(lead_id, user.sub)
    contact = await contacts_repo.get(contact_id)
    if not contact or contact.get("user_id") != user.sub or contact.get("lead_id") != lead_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Contact '{contact_id}' not found.")
    current = review_status_of(contact)
    if not review_allowed(current, body.decision):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_review_transition",
                "message": "Ese cambio de revisión no está permitido.",
                "review_status": current,
            },
        )
    updated = await contacts_repo.update(contact_id, {"review_status": body.decision, "reviewed_at": now_utc()})
    active = await contact_research_service.get_service().list_contacts(lead_id, user.sub)
    lead_status = await leads_repo.recompute_status_after_review(lead_id, user.sub, bool(active), now_utc())
    return {**updated, "lead_status": lead_status}
