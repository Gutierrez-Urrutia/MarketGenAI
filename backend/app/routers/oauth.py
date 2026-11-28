"""Google and Microsoft OAuth2 authorization code flow."""
from __future__ import annotations

import base64
import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
import jwt
from jwt import PyJWTError as JWTError

from app.config import settings
from app.dependencies.auth import CurrentUser, require_roles
from app.services.auth_service import (
    create_access_token,
    hash_token,
    new_opaque_token,
    public_user,
    refresh_expires_at,
)
from app.services.firestore_service import refresh_tokens_repo, users_repo
from app.services.graph_client import code_challenge, new_code_verifier

router = APIRouter(prefix="/auth", tags=["OAuth"])

_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

MICROSOFT_LOGIN_URL = "https://login.microsoftonline.com"
MICROSOFT_USER_URL = "https://graph.microsoft.com/v1.0/me"
MICROSOFT_SCOPES = "openid email profile User.Read"

# State y verificador PKCE del login con Microsoft: viajan en una cookie firmada de corta vida (sin tocar Firestore).
_MS_COOKIE = "mg_ms_oauth"
_MS_COOKIE_PATH = "/api/v1/auth/microsoft"
_MS_STATE_TTL_SECONDS = 600
_MS_COOKIE_TYPE = "ms_oauth"  # distinto de "access": esta cookie nunca sirve como token de sesión

logger = logging.getLogger(__name__)


class OAuthRefused(Exception):
    """El inicio de sesión social se rechaza por una razón conocida; `code` va al frontend como oauth_error."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _base_url(request: Request) -> str:
    """Return the scheme+host of the current request, respecting Vercel proxy headers."""
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", request.url.hostname))
    return f"{scheme}://{host}"


def _google_callback_url(request: Request) -> str:
    return settings.google_redirect_uri or f"{_base_url(request)}/api/v1/auth/google/callback"


def _microsoft_callback_url(request: Request) -> str:
    return settings.microsoft_redirect_uri or f"{_base_url(request)}/api/v1/auth/microsoft/callback"


def _microsoft_configured() -> bool:
    return bool(
        settings.microsoft_oauth_client_id
        and settings.microsoft_oauth_client_secret
        and settings.microsoft_tenant_id
    )


def _microsoft_endpoint(kind: str) -> str:
    """authorize o token del inquilino configurado (no `common`: solo entra la organización)."""
    tenant = quote(settings.microsoft_tenant_id.strip(), safe="")
    return f"{MICROSOFT_LOGIN_URL}/{tenant}/oauth2/v2.0/{kind}"


def _sign_microsoft_state(state: str, verifier: str) -> str:
    payload = {
        "typ": _MS_COOKIE_TYPE,
        "st": state,
        "cv": verifier,
        "exp": datetime.now(timezone.utc) + timedelta(seconds=_MS_STATE_TTL_SECONDS),
    }
    return jwt.encode(payload, settings.app_secret_key, algorithm="HS256")


def _read_microsoft_state(request: Request) -> Optional[dict]:
    """La cookie del inicio del login, o None si falta, está manipulada, vencida o no es de este flujo."""
    raw = request.cookies.get(_MS_COOKIE)
    if not raw:
        return None
    try:
        data = jwt.decode(raw, settings.app_secret_key, algorithms=["HS256"])
    except JWTError:
        return None
    if data.get("typ") != _MS_COOKIE_TYPE or not data.get("st") or not data.get("cv"):
        return None
    return data


def _microsoft_error(reason: str) -> RedirectResponse:
    response = _error_redirect(reason)
    response.delete_cookie(_MS_COOKIE, path=_MS_COOKIE_PATH)
    return response


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
        # Mismas reglas que el login con contraseña (auth.py): una cuenta inactiva no entra por una red social.
        if user.get("status") != "active":
            raise OAuthRefused("account_disabled")
        # Esa cuenta ya está ligada a otra identidad del mismo proveedor: el correo solo no basta para entrar.
        linked_id = user.get(f"{provider}Id")
        if linked_id and provider_id and linked_id != provider_id:
            raise OAuthRefused("account_mismatch")
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
async def debug_urls(request: Request, _admin: CurrentUser = Depends(require_roles("admin"))):
    # Solo admin: antes era público y devolvía todas las cabeceras de la petición.
    return {
        "google_callback": _google_callback_url(request),
        "microsoft_callback": _microsoft_callback_url(request),
        "frontend_callback": _frontend_callback_url(),
        "base_url": _base_url(request),
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
    except OAuthRefused as refused:
        return _error_redirect(refused.code)
    except Exception as exc:
        import traceback, logging
        logging.error("Google OAuth callback error: %s\n%s", exc, traceback.format_exc())
        return _error_redirect("google_server_error")


# ── Microsoft ─────────────────────────────────────────────────────────────────

@router.get("/microsoft")
async def microsoft_auth(request: Request) -> RedirectResponse:
    if not _microsoft_configured():
        raise HTTPException(
            status_code=501, detail="Microsoft OAuth no está configurado."
        )
    redirect_uri = _microsoft_callback_url(request)
    state = secrets.token_urlsafe(32)
    verifier = new_code_verifier()
    params = {
        "client_id": settings.microsoft_oauth_client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": MICROSOFT_SCOPES,
        "state": state,
        "code_challenge": code_challenge(verifier),
        "code_challenge_method": "S256",
    }
    response = RedirectResponse(f"{_microsoft_endpoint('authorize')}?{urlencode(params)}", status_code=302)
    response.set_cookie(
        _MS_COOKIE,
        _sign_microsoft_state(state, verifier),
        max_age=_MS_STATE_TTL_SECONDS,
        path=_MS_COOKIE_PATH,
        httponly=True,
        secure=redirect_uri.startswith("https://"),
        samesite="lax",
    )
    return response


@router.get("/microsoft/callback")
async def microsoft_callback(
    request: Request, code: str = None, error: str = None, state: str = None
) -> RedirectResponse:
    if error or not code:
        return _microsoft_error("microsoft_denied")
    if not _microsoft_configured():
        return _microsoft_error("microsoft_server_error")

    # CSRF y PKCE: el state que vuelve debe ser el que este navegador recibió al empezar.
    pending = _read_microsoft_state(request)
    if not pending or not state or not secrets.compare_digest(str(pending["st"]), state):
        return _microsoft_error("microsoft_state_invalid")

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            token_resp = await client.post(
                _microsoft_endpoint("token"),
                data={
                    "code": code,
                    "client_id": settings.microsoft_oauth_client_id,
                    "client_secret": settings.microsoft_oauth_client_secret,
                    "redirect_uri": _microsoft_callback_url(request),
                    "grant_type": "authorization_code",
                    "scope": MICROSOFT_SCOPES,
                    "code_verifier": pending["cv"],
                },
            )
            if token_resp.status_code != 200:
                return _microsoft_error("microsoft_token_failed")

            token_body = token_resp.json()
            # El id_token llega directo del endpoint de Microsoft por TLS (flujo de código): se comprueba de qué
            # directorio y para qué aplicación es; Entra ya impone el inquilino, esto es una segunda barrera.
            try:
                claims = jwt.decode(token_body.get("id_token") or "", options={"verify_signature": False})
            except JWTError:
                return _microsoft_error("microsoft_token_failed")
            if (
                str(claims.get("tid", "")).lower() != settings.microsoft_tenant_id.strip().lower()
                or claims.get("aud") != settings.microsoft_oauth_client_id
            ):
                return _microsoft_error("microsoft_wrong_tenant")

            userinfo_resp = await client.get(
                MICROSOFT_USER_URL,
                headers={"Authorization": f"Bearer {token_body.get('access_token')}"},
            )
            if userinfo_resp.status_code != 200:
                return _microsoft_error("microsoft_userinfo_failed")
            userinfo = userinfo_resp.json()

        email = (userinfo.get("mail") or userinfo.get("userPrincipalName") or "").strip()
        name = userinfo.get("displayName") or "Microsoft User"
        provider_id = userinfo.get("id", "")

        if not email or "@" not in email or not provider_id:
            return _microsoft_error("microsoft_no_email")

        user = await _find_or_create_oauth_user(email, name, "microsoft", provider_id)
        response = await _issue_session_and_redirect(user)
        response.delete_cookie(_MS_COOKIE, path=_MS_COOKIE_PATH)
        return response
    except OAuthRefused as refused:
        return _microsoft_error(refused.code)
    except Exception as exc:
        import traceback, logging
        logging.error("Microsoft OAuth callback error: %s\n%s", exc, traceback.format_exc())
        return _microsoft_error("microsoft_server_error")
