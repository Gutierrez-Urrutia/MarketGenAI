"""Google and Microsoft OAuth2 authorization code flow."""
from __future__ import annotations

import base64
import json
import logging
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from app.config import settings
from app.services.auth_service import (
    create_access_token,
    hash_token,
    new_opaque_token,
    public_user,
    refresh_expires_at,
)
from app.services.firestore_service import refresh_tokens_repo, users_repo

router = APIRouter(prefix="/auth", tags=["OAuth"])

_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
MICROSOFT_USER_URL = "https://graph.microsoft.com/v1.0/me"
MICROSOFT_SCOPES = "openid email profile User.Read"

logger = logging.getLogger(__name__)


def _base_url(request: Request) -> str:
    """Return the scheme+host of the current request, respecting Vercel proxy headers."""
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", request.url.hostname))
    return f"{scheme}://{host}"


def _google_callback_url(request: Request) -> str:
    return settings.google_redirect_uri or f"{_base_url(request)}/api/v1/auth/google/callback"


def _microsoft_callback_url(request: Request) -> str:
    base = getattr(settings, "backend_url", None) or "http://localhost:8000"
    base = base.replace("127.0.0.1", "localhost")
    return f"{base}/api/v1/auth/microsoft/callback"


def _frontend_callback_url() -> str:
    return f"{settings.frontend_url.rstrip('/')}/auth/callback"


def _error_redirect(reason: str) -> RedirectResponse:
    return RedirectResponse(
        f"{_frontend_callback_url()}?oauth_error={reason}", status_code=302
    )


async def _issue_session_and_redirect(user: dict) -> RedirectResponse:
    access_token = create_access_token(user)
    refresh_token = new_opaque_token()
    await refresh_tokens_repo.create_token(
        hash_token(refresh_token),
        {"userId": user["id"], "expiresAt": refresh_expires_at(), "revokedAt": None},
    )
    await users_repo.touch_login(user["id"])

    pub = public_user(user)
    user_b64 = base64.urlsafe_b64encode(json.dumps(pub).encode()).decode()

    params = urlencode(
        {
            "oauth_access_token": access_token,
            "oauth_refresh_token": refresh_token,
            "oauth_expires_in": settings.access_token_expire_minutes * 60,
            "oauth_user": user_b64,
        }
    )
    return RedirectResponse(f"{_frontend_callback_url()}?{params}", status_code=302)


async def _find_or_create_oauth_user(
    email: str, name: str, provider: str, provider_id: str
) -> dict:
    email = email.lower()
    user = await users_repo.get_by_email(email)
    if user:
        updates = {}
        if not user.get(f"{provider}Id"):
            updates[f"{provider}Id"] = provider_id
        if user.get("provider") != provider:
            updates["provider"] = provider
        if user.get("authProvider") != provider:
            updates["authProvider"] = provider
        if updates:
            await users_repo.update(user["id"], updates)
        return user
    return await users_repo.create_user(
        {
            "email": email,
            "name": name,
            "passwordHash": "",
            "roles": ["user"],
            "status": "active",
            f"{provider}Id": provider_id,
            "provider": provider,
            "authProvider": provider,
        }
    )


# ── Debug ─────────────────────────────────────────────────────────────────────

@router.get("/debug-urls")
async def debug_urls(request: Request):
    return {
        "google_callback": _google_callback_url(request),
        "microsoft_callback": _microsoft_callback_url(request),
        "frontend_callback": _frontend_callback_url(),
        "base_url": _base_url(request),
        "headers": dict(request.headers),
    }


# ── Google ────────────────────────────────────────────────────────────────────

@router.get("/google")
async def google_auth(request: Request) -> RedirectResponse:
    if not settings.google_oauth_client_id:
        raise HTTPException(status_code=501, detail="Google OAuth no está configurado.")
    redirect_uri = _google_callback_url(request)
    logger.warning("Google OAuth redirect_uri: %s", redirect_uri)
    params = {
        "client_id": settings.google_oauth_client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "state": secrets.token_urlsafe(16),
    }
    return RedirectResponse(f"{_GOOGLE_AUTH_URL}?{urlencode(params)}", status_code=302)


@router.get("/google/callback")
async def google_callback(request: Request, code: str = None, error: str = None) -> RedirectResponse:
    if error or not code:
        return _error_redirect("google_denied")

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            token_resp = await client.post(
                _GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": settings.google_oauth_client_id,
                    "client_secret": settings.google_oauth_client_secret,
                    "redirect_uri": _google_callback_url(request),
                    "grant_type": "authorization_code",
                },
            )
            if token_resp.status_code != 200:
                return _error_redirect("google_token_failed")

            google_access_token = token_resp.json().get("access_token")
            userinfo_resp = await client.get(
                _GOOGLE_USERINFO_URL,
                headers={"Authorization": f"Bearer {google_access_token}"},
            )
            if userinfo_resp.status_code != 200:
                return _error_redirect("google_userinfo_failed")
            userinfo = userinfo_resp.json()

        email = userinfo.get("email", "")
        name = userinfo.get("name") or userinfo.get("given_name") or "Google User"
        provider_id = userinfo.get("sub", "")

        if not email:
            return _error_redirect("google_no_email")

        user = await _find_or_create_oauth_user(email, name, "google", provider_id)
        return await _issue_session_and_redirect(user)
    except Exception as exc:
        import traceback, logging
        logging.error("Google OAuth callback error: %s\n%s", exc, traceback.format_exc())
        return _error_redirect("google_server_error")


# ── Microsoft ─────────────────────────────────────────────────────────────────

@router.get("/microsoft")
async def microsoft_auth(request: Request) -> RedirectResponse:
    if not settings.microsoft_oauth_client_id:
        raise HTTPException(
            status_code=501, detail="Microsoft OAuth no está configurado."
        )
    params = {
        "client_id": settings.microsoft_oauth_client_id,
        "redirect_uri": _microsoft_callback_url(request),
        "response_type": "code",
        "scope": MICROSOFT_SCOPES,
        "state": secrets.token_urlsafe(16),
    }
    return RedirectResponse(f"{MICROSOFT_AUTH_URL}?{urlencode(params)}", status_code=302)


@router.get("/microsoft/callback")
async def microsoft_callback(request: Request, code: str = None, error: str = None) -> RedirectResponse:
    if error or not code:
        return _error_redirect("microsoft_denied")

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            token_resp = await client.post(
                MICROSOFT_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": settings.microsoft_oauth_client_id,
                    "client_secret": settings.microsoft_oauth_client_secret,
                    "redirect_uri": _microsoft_callback_url(request),
                    "grant_type": "authorization_code",
                    "scope": MICROSOFT_SCOPES,
                },
            )
            if token_resp.status_code != 200:
                return _error_redirect("microsoft_token_failed")

            ms_access_token = token_resp.json().get("access_token")
            userinfo_resp = await client.get(
                MICROSOFT_USER_URL,
                headers={"Authorization": f"Bearer {ms_access_token}"},
            )
            if userinfo_resp.status_code != 200:
                return _error_redirect("microsoft_userinfo_failed")
            userinfo = userinfo_resp.json()

        email = userinfo.get("mail") or userinfo.get("userPrincipalName", "")
        name = userinfo.get("displayName") or "Microsoft User"
        provider_id = userinfo.get("id", "")

        if not email or "@" not in email:
            return _error_redirect("microsoft_no_email")

        user = await _find_or_create_oauth_user(email, name, "microsoft", provider_id)
        return await _issue_session_and_redirect(user)
    except Exception as exc:
        import traceback, logging
        logging.error("Microsoft OAuth callback error: %s\n%s", exc, traceback.format_exc())
        return _error_redirect("microsoft_server_error")
