"""Prospecting emails router (Agente 3, RF-VTA-16).

POST /outreach-emails writes an email for one contact of one lead; the review
actions approve, reject and mark it as sent (`mark-sent` is only a mark —
nothing is sent from here) and regenerate it while pending. Every route
checks that the email / lead is the caller's: 404 when it does not exist,
403 when it is someone else's. Refusals carry a code in `detail.code`.
"""
# No `from __future__ import annotations` here: @limiter.limit wraps the
# endpoint, and FastAPI could not resolve a string annotation of the body
# model through the wrapper — same as routers/leads.py.
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from app.core.rate_limit import limiter
from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.outreach_email import (
    EmailStatus,
    OutreachEmailCreate,
    OutreachEmailListResponse,
    OutreachEmailResponse,
)
from app.services import outreach_email_service
from app.services.outreach_email_service import OutreachEmailError

router = APIRouter(prefix="/outreach-emails", tags=["Outreach emails"])

GENERATION_RATE_LIMIT = "20/minute"


def _user_name(user: CurrentUser) -> str:
    return user.name or user.email or user.sub


def _http(exc: OutreachEmailError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.post("", response_model=OutreachEmailResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit(GENERATION_RATE_LIMIT)
async def generate_outreach_email(
    request: Request,
    body: OutreachEmailCreate,
    user: CurrentUser = Depends(get_current_user),
):
    """Write an email for a non-rejected contact with an email address.
    Refusals: 404 lead_not_found / contact_not_found, 403 forbidden,
    422 contact_rejected / contact_without_email / lead_not_composable,
    409 email_already_active / compose_in_progress,
    502 generation_failed / invalid_model_output (nothing stored, the lead
    goes back to its previous status)."""
    try:
        return await outreach_email_service.get_service().generate(
            body.lead_id, body.contact_id, user.sub, _user_name(user),
        )
    except OutreachEmailError as exc:
        raise _http(exc)


@router.get("", response_model=OutreachEmailListResponse)
async def list_outreach_emails(
    status_filter: Optional[EmailStatus] = Query(None, alias="status"),
    lead_id: Optional[str] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    items = await outreach_email_service.get_service().list_emails(
        user.sub, status=status_filter.value if status_filter else None, lead_id=lead_id,
    )
    return OutreachEmailListResponse(items=items, total=len(items))


@router.get("/{email_id}", response_model=OutreachEmailResponse)
async def get_outreach_email(email_id: str, user: CurrentUser = Depends(get_current_user)):
    try:
        return await outreach_email_service.get_service().email_for_user(email_id, user.sub)
    except OutreachEmailError as exc:
        raise _http(exc)


async def _decide(email_id: str, user: CurrentUser, action: str):
    try:
        return await outreach_email_service.get_service().decide(email_id, user.sub, _user_name(user), action)
    except OutreachEmailError as exc:
        raise _http(exc)


@router.patch("/{email_id}/approve", response_model=OutreachEmailResponse)
async def approve_outreach_email(email_id: str, user: CurrentUser = Depends(get_current_user)):
    """pending_review → approved. 422 contact_not_approved while the contact
    still needs review (or was rejected)."""
    return await _decide(email_id, user, "approve")


@router.patch("/{email_id}/reject", response_model=OutreachEmailResponse)
async def reject_outreach_email(email_id: str, user: CurrentUser = Depends(get_current_user)):
    """pending_review | approved → rejected (final)."""
    return await _decide(email_id, user, "reject")


@router.patch("/{email_id}/mark-sent", response_model=OutreachEmailResponse)
async def mark_outreach_email_sent(email_id: str, user: CurrentUser = Depends(get_current_user)):
    """approved → sent. Only a mark: no email is sent. 422 contact_rejected
    when the contact was rejected meanwhile."""
    return await _decide(email_id, user, "mark_sent")


@router.patch("/{email_id}/regenerate", response_model=OutreachEmailResponse)
@limiter.limit(GENERATION_RATE_LIMIT)
async def regenerate_outreach_email(request: Request, email_id: str, user: CurrentUser = Depends(get_current_user)):
    """Write the email again while pending_review; the previous version stays
    in the history."""
    try:
        return await outreach_email_service.get_service().regenerate(email_id, user.sub, _user_name(user))
    except OutreachEmailError as exc:
        raise _http(exc)
