"""Prospecting emails router (Agente 3, RF-VTA-16).

POST /outreach-emails writes an email for one contact of one lead; the review
actions approve, reject and mark it as sent (`mark-sent` is only a mark —
nothing is sent by it) and regenerate it while pending. POST /{id}/send
delivers an approved email by SMTP with the user's account, only with both
real-send switches on (OUTREACH_REAL_SEND_ENABLED and the user's own); GET
/send-status says whether that is possible, and /do-not-contact holds the
addresses and domains never to email. Every route checks that the email /
lead is the caller's: 404 when it does not exist, 403 when it is someone
else's. Refusals carry a code in `detail.code`.
"""
# No `from __future__ import annotations` here: @limiter.limit wraps the
# endpoint, and FastAPI could not resolve a string annotation of the body
# model through the wrapper — same as routers/leads.py.
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response, status

from app.core.pipeline_constants import OUTREACH_SEND_RATE_LIMIT
from app.core.rate_limit import limiter
from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.outreach_email import (
    DoNotContactCreate,
    DoNotContactEntry,
    DoNotContactListResponse,
    EmailStatus,
    OutreachEmailCreate,
    OutreachEmailListResponse,
    OutreachEmailRegenerate,
    OutreachEmailResponse,
    OutreachEmailSend,
    SendStatusResponse,
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
    """Write an email for a non-rejected contact with an email address, in
    `language` (en / es / pt; default en). Refusals: 422 invalid_language, 404 lead_not_found / contact_not_found, 403 forbidden,
    422 contact_rejected / contact_without_email / lead_not_composable,
    409 email_already_active / compose_in_progress,
    502 generation_failed / invalid_model_output (nothing stored, the lead
    goes back to its previous status)."""
    try:
        return await outreach_email_service.get_service().generate(
            body.lead_id, body.contact_id, user.sub, _user_name(user), body.language,
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


@router.get("/send-status", response_model=SendStatusResponse)
async def get_send_status(user: CurrentUser = Depends(get_current_user)):
    """Whether «Enviar» can be used: account complete (and what is missing),
    the server's and the user's switches, today's quota. No secret in it."""
    return await outreach_email_service.get_service().send_status(user.sub)


@router.get("/do-not-contact", response_model=DoNotContactListResponse)
async def list_do_not_contact(user: CurrentUser = Depends(get_current_user)):
    items = await outreach_email_service.get_service().list_do_not_contact(user.sub)
    return DoNotContactListResponse(items=items, total=len(items))


@router.post("/do-not-contact", response_model=DoNotContactEntry, status_code=status.HTTP_201_CREATED)
async def add_do_not_contact(body: DoNotContactCreate, user: CurrentUser = Depends(get_current_user)):
    """Add exactly one of `email_id` (its recipient, read by the server),
    `email` or `domain`. Adding an existing entry returns it. 422
    invalid_do_not_contact / contact_without_email, 404 email_not_found, 403
    forbidden."""
    try:
        return await outreach_email_service.get_service().add_do_not_contact(
            user.sub, email_id=body.email_id, address=body.email, domain=body.domain, reason=body.reason,
        )
    except OutreachEmailError as exc:
        raise _http(exc)


@router.delete("/do-not-contact/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_do_not_contact(entry_id: str, user: CurrentUser = Depends(get_current_user)):
    """404 do_not_contact_not_found for a missing entry or someone else's."""
    try:
        await outreach_email_service.get_service().remove_do_not_contact(user.sub, entry_id)
    except OutreachEmailError as exc:
        raise _http(exc)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
    """pending_review | approved → rejected (final). 409 send_in_progress
    while an SMTP send of it is running."""
    return await _decide(email_id, user, "reject")


@router.patch("/{email_id}/mark-sent", response_model=OutreachEmailResponse)
async def mark_outreach_email_sent(email_id: str, user: CurrentUser = Depends(get_current_user)):
    """approved → sent (send_method manual). Only a mark: no email is sent.
    422 contact_rejected when the contact was rejected meanwhile; 409
    send_in_progress while an SMTP send of it is running. Allowed after a send
    of unknown outcome (smtp_timeout), and it frees that send's lock."""
    return await _decide(email_id, user, "mark_sent")


@router.post("/{email_id}/send", response_model=OutreachEmailResponse)
@limiter.limit(OUTREACH_SEND_RATE_LIMIT)
async def send_outreach_email(
    request: Request,
    email_id: str,
    body: OutreachEmailSend,
    user: CurrentUser = Depends(get_current_user),
):
    """approved → sent by SMTP (send_method smtp), to the recipient the user
    confirmed in `confirm_to_email`. See OutreachEmailService.send for every
    refusal code; a 504 smtp_timeout means the email may have been sent: retry
    only with `force_retry`, or mark it as sent."""
    try:
        return await outreach_email_service.get_service().send(
            email_id, user.sub, _user_name(user), body.confirm_to_email, body.force_retry,
        )
    except OutreachEmailError as exc:
        raise _http(exc)


@router.patch("/{email_id}/regenerate", response_model=OutreachEmailResponse)
@limiter.limit(GENERATION_RATE_LIMIT)
async def regenerate_outreach_email(
    request: Request,
    email_id: str,
    body: Optional[OutreachEmailRegenerate] = Body(None),
    user: CurrentUser = Depends(get_current_user),
):
    """Write the email again while pending_review, in `language` or, without
    one, in the email's current language; the previous version stays in the
    history. 422 invalid_language for a language outside en / es / pt."""
    try:
        return await outreach_email_service.get_service().regenerate(
            email_id, user.sub, _user_name(user), body.language if body else None,
        )
    except OutreachEmailError as exc:
        raise _http(exc)
