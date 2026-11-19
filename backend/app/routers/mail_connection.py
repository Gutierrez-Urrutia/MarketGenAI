"""Mailbox connection router (RF-VTA-16): connect the user's own Microsoft
365 / Outlook mailbox or their Gmail by OAuth, see its state, test it and
disconnect it.

  POST   /mail-connection/start     → {authorize_url}; the frontend navigates there.
                                      Body {"provider": "microsoft" | "google"}
                                      (optional; Microsoft when omitted)
  POST   /mail-connection/callback  ← Microsoft's answer (form_post); no JWT:
                                      the single-use `state` says whose it is.
                                      Always a 303 to the frontend.
  GET    /mail-connection/google/callback ← Google's answer (query string); same
                                      rules. The code is single use and useless
                                      without the PKCE verifier kept server side.
  GET    /mail-connection/status    → connected / needs_reconnect / address
  POST   /mail-connection/test      → reads the mailbox (GET /me); sends nothing
  DELETE /mail-connection           → forgets the mailbox and its tokens

Refusals carry a code in `detail.code` (mail_connection_service). Nothing
here ever returns or logs a token, the code or the state.
"""
# No `from __future__ import annotations`: @limiter.limit wraps the endpoints
# (same as routers/outreach_emails.py).
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse

from app.core.pipeline_constants import MAIL_CONNECTION_RATE_LIMIT
from app.core.rate_limit import limiter
from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.mail_connection import (
    MailConnectionStart,
    MailConnectionStartRequest,
    MailConnectionStatus,
    MailConnectionTest,
)
from app.services import mail_connection_service
from app.services.mail_connection_service import MailConnectionError

router = APIRouter(prefix="/mail-connection", tags=["Mail connection"])


def _http(exc: MailConnectionError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.post("/start", response_model=MailConnectionStart)
@limiter.limit(MAIL_CONNECTION_RATE_LIMIT)
async def start_mail_connection(
    request: Request,
    body: Optional[MailConnectionStartRequest] = None,
    user: CurrentUser = Depends(get_current_user),
):
    """422 unknown_provider, 503 mail_oauth_not_configured /
    mail_endpoints_not_allowed / encryption_not_configured."""
    provider = body.provider if body else "microsoft"
    try:
        return await mail_connection_service.get_service().start(user.sub, provider, login_hint=user.email)
    except MailConnectionError as exc:
        raise _http(exc)


@router.post("/callback", include_in_schema=False)
async def mail_connection_callback(
    state: Optional[str] = Form(None),
    code: Optional[str] = Form(None),
    error: Optional[str] = Form(None),
    error_description: Optional[str] = Form(None),
):
    url = await mail_connection_service.get_service().complete(state, code, error, error_description)
    # 303: the browser follows with a GET; no-store so the answer is never cached.
    return RedirectResponse(url, status_code=status.HTTP_303_SEE_OTHER, headers={"Cache-Control": "no-store"})


@router.get("/google/callback", include_in_schema=False)
async def mail_connection_google_callback(
    state: Optional[str] = Query(None),
    code: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None),
):
    url = await mail_connection_service.get_service().complete(state, code, error, error_description)
    return RedirectResponse(url, status_code=status.HTTP_303_SEE_OTHER, headers={"Cache-Control": "no-store"})


@router.get("/status", response_model=MailConnectionStatus)
async def mail_connection_status(user: CurrentUser = Depends(get_current_user)):
    return await mail_connection_service.get_service().status(user.sub)


@router.post("/test", response_model=MailConnectionTest)
@limiter.limit(MAIL_CONNECTION_RATE_LIMIT)
async def test_mail_connection(request: Request, user: CurrentUser = Depends(get_current_user)):
    """409 mailbox_not_connected / mailbox_reconnect_required /
    missing_permissions, 502 mail_service_unavailable / mailbox_auth_failed,
    503 mail_throttled / encryption_not_configured, 504 mail_service_timeout."""
    try:
        return await mail_connection_service.get_service().test(user.sub)
    except MailConnectionError as exc:
        raise _http(exc)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect_mail_connection(user: CurrentUser = Depends(get_current_user)):
    await mail_connection_service.get_service().disconnect(user.sub)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
