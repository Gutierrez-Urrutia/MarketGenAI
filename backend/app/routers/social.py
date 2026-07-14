"""Social account connections and publishing helpers."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any, Dict, Optional
from urllib.parse import quote_plus

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import RedirectResponse
from google.auth.exceptions import DefaultCredentialsError
from jose import JWTError, jwt
from pydantic import BaseModel, Field

from app.config import settings
from app.dependencies.auth import CurrentUser, get_current_user
from app.services.auth_service import JWT_ALGORITHM, utc_now
from app.services.firestore_service import settings_repo

router = APIRouter(prefix="/settings/social", tags=["Social Integrations"])

logger = logging.getLogger(__name__)

_GRAPH_BASE = f"https://graph.facebook.com/{settings.meta_graph_api_version}"
_STATE_PURPOSE = "social_connect"
_STATE_TTL_MINUTES = 10
_local_social_accounts: Dict[str, Dict[str, Any]] = {}


class ManualSocialConnectRequest(BaseModel):
    email: str = Field("", max_length=240)
    handle: str = Field("", max_length=120)
    accessToken: str = Field("", max_length=5000)


class SocialPublishRequest(BaseModel):
    platform: str
    content: str = Field(..., min_length=1, max_length=6000)
    title: str = Field("", max_length=240)
    url: str = Field("", max_length=1000)


def _meta_redirect_uri() -> str:
    return settings.meta_redirect_uri or f"{settings.oauth_redirect_base_url}/settings/social/facebook/callback"


def _frontend_settings_url(query: str) -> str:
    return f"{settings.frontend_url.rstrip('/')}/dashboard?{query}"


def _sign_state(user_id: str, platform: str) -> str:
    now = utc_now()
    payload = {
        "sub": user_id,
        "platform": platform,
        "typ": _STATE_PURPOSE,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=_STATE_TTL_MINUTES)).timestamp()),
    }
    return jwt.encode(payload, settings.app_secret_key, algorithm=JWT_ALGORITHM)


def _verify_state(state: str, platform: str) -> str:
    try:
        payload = jwt.decode(state, settings.app_secret_key, algorithms=[JWT_ALGORITHM])
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired state.") from exc
    if payload.get("typ") != _STATE_PURPOSE or payload.get("platform") != platform:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid state.")
    return payload["sub"]


def _normalize_platform(value: str) -> str:
    normalized = value.lower().strip()
    aliases = {
        "x": "twitter",
        "twitter / x": "twitter",
        "twitter/x": "twitter",
        "twitter": "twitter",
        "linkedin": "linkedin",
        "facebook": "facebook",
    }
    return aliases.get(normalized, normalized)


def _platform_label(platform: str) -> str:
    return {
        "facebook": "Facebook",
        "linkedin": "LinkedIn",
        "twitter": "Twitter / X",
    }.get(platform, platform.title())


def _platform_env_connected(platform: str) -> bool:
    if platform == "facebook":
        return bool(settings.meta_access_token)
    if platform == "linkedin":
        return bool(settings.linkedin_access_token)
    if platform == "twitter":
        return bool(settings.twitter_api_key and settings.twitter_api_secret)
    return False


async def _get_social_accounts(user_id: str) -> Dict[str, Any]:
    try:
        doc = await settings_repo.get(user_id)
    except DefaultCredentialsError:
        return _local_social_accounts.get(user_id, {})
    return (doc or {}).get("socialAccounts", {})


async def _save_social_account(user_id: str, platform: str, data: Optional[Dict[str, Any]]) -> None:
    try:
        existing = await settings_repo.get(user_id)
    except DefaultCredentialsError:
        accounts = _local_social_accounts.get(user_id, {}).copy()
        if data is None:
            accounts.pop(platform, None)
        else:
            accounts[platform] = data
        _local_social_accounts[user_id] = accounts
        return

    accounts = (existing or {}).get("socialAccounts", {})
    if data is None:
        accounts.pop(platform, None)
    else:
        accounts[platform] = data
    payload = {"socialAccounts": accounts, "userId": user_id}
    if existing:
        await settings_repo.update(user_id, payload)
    else:
        await settings_repo.create(payload, doc_id=user_id)


def _manual_status(platform: str, accounts: Dict[str, Any]) -> Dict[str, Any]:
    data = accounts.get(platform) or {}
    env_connected = _platform_env_connected(platform)
    connected = bool(data) or env_connected
    return {
        "connected": connected,
        "platform": platform,
        "label": _platform_label(platform),
        "user": data.get("handle") or data.get("email") or ("Configured token" if env_connected else ""),
        "connectedAt": data.get("connectedAt"),
        "connectionType": data.get("connectionType") or ("environment" if env_connected else None),
        "canPublish": connected,
    }


def _public_status(accounts: Dict[str, Any]) -> Dict[str, Any]:
    """Never leak access tokens to the frontend, only connection status."""
    facebook = accounts.get("facebook") or {}
    instagram = facebook.get("instagram") or {}
    facebook_status = _manual_status("facebook", accounts)
    return {
        "facebook": {
            **facebook_status,
            "pageId": facebook.get("pageId"),
            "pageName": facebook.get("pageName"),
            "user": facebook.get("pageName") or facebook_status["user"],
        },
        "instagram": {
            "connected": bool(instagram.get("businessId")),
            "username": instagram.get("username"),
        },
        "linkedin": _manual_status("linkedin", accounts),
        "twitter": _manual_status("twitter", accounts),
    }


def _share_url(platform: str, text: str, url: str = "") -> str:
    encoded_text = quote_plus(text)
    encoded_url = quote_plus(url or "https://marketgenai.vercel.app")
    if platform == "twitter":
        return f"https://twitter.com/intent/tweet?text={encoded_text}"
    if platform == "linkedin":
        return f"https://www.linkedin.com/feed/?shareActive=true&text={encoded_text}"
    if platform == "facebook":
        return f"https://www.facebook.com/sharer/sharer.php?u={encoded_url}&quote={encoded_text}"
    raise HTTPException(status_code=422, detail="Unsupported social platform.")


@router.get("/status")
async def social_status(user: CurrentUser = Depends(get_current_user)):
    accounts = await _get_social_accounts(user.sub)
    return _public_status(accounts)


@router.post("/publish")
async def publish_social_post(
    body: SocialPublishRequest,
    user: CurrentUser = Depends(get_current_user),
):
    platform = _normalize_platform(body.platform)
    accounts = await _get_social_accounts(user.sub)
    platform_status = _public_status(accounts).get(platform)
    if not platform_status or not platform_status.get("connected"):
        raise HTTPException(status_code=409, detail=f"{_platform_label(platform)} is not connected.")

    text = body.content.strip()
    if body.title.strip() and body.title.strip() not in text:
        text = f"{body.title.strip()}\n\n{text}"

    return {
        "platform": platform,
        "status": "ready_to_publish",
        "message": "Open the provider composer to review and publish the post.",
        "shareUrl": _share_url(platform, text, body.url),
    }


@router.post("/{platform}/manual")
async def manual_social_connect(
    platform: str,
    body: ManualSocialConnectRequest,
    user: CurrentUser = Depends(get_current_user),
):
    normalized = _normalize_platform(platform)
    if normalized not in {"facebook", "linkedin", "twitter"}:
        raise HTTPException(status_code=422, detail="Unsupported social platform.")

    email = body.email.strip()
    handle = body.handle.strip().lstrip("@")
    access_token = body.accessToken.strip()
    if not email and not handle and not access_token and not _platform_env_connected(normalized):
        raise HTTPException(status_code=422, detail="Add an email, handle, or access token to connect this platform.")

    await _save_social_account(user.sub, normalized, {
        "email": email,
        "handle": handle,
        "accessToken": access_token,
        "connectionType": "manual",
        "connectedAt": utc_now().isoformat(),
    })
    accounts = await _get_social_accounts(user.sub)
    return _public_status(accounts)[normalized]


@router.post("/facebook/connect")
async def facebook_connect(user: CurrentUser = Depends(get_current_user)):
    if not settings.meta_app_id:
        raise HTTPException(status_code=501, detail="Facebook/Instagram integration is not configured (missing META_APP_ID).")

    state = _sign_state(user.sub, "facebook")
    scopes = ",".join([
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_posts",
        "instagram_basic",
        "instagram_content_publish",
        "business_management",
    ])
    params = httpx.QueryParams({
        "client_id": settings.meta_app_id,
        "redirect_uri": _meta_redirect_uri(),
        "state": state,
        "scope": scopes,
        "response_type": "code",
    })
    return {"platform": "facebook", "authUrl": f"https://www.facebook.com/{settings.meta_graph_api_version}/dialog/oauth?{params}"}


@router.get("/facebook/callback")
async def facebook_callback(code: str = None, state: str = None, error: str = None):
    if error or not code or not state:
        return RedirectResponse(_frontend_settings_url("social_error=facebook_denied"), status_code=302)

    user_id = _verify_state(state, "facebook")

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            short_lived = await client.get(f"{_GRAPH_BASE}/oauth/access_token", params={
                "client_id": settings.meta_app_id,
                "client_secret": settings.meta_app_secret,
                "redirect_uri": _meta_redirect_uri(),
                "code": code,
            })
            if short_lived.status_code != 200:
                logger.warning("Facebook token exchange failed: %s", short_lived.text)
                return RedirectResponse(_frontend_settings_url("social_error=facebook_token_failed"), status_code=302)
            short_lived_token = short_lived.json().get("access_token")

            long_lived = await client.get(f"{_GRAPH_BASE}/oauth/access_token", params={
                "grant_type": "fb_exchange_token",
                "client_id": settings.meta_app_id,
                "client_secret": settings.meta_app_secret,
                "fb_exchange_token": short_lived_token,
            })
            user_token = long_lived.json().get("access_token", short_lived_token) if long_lived.status_code == 200 else short_lived_token

            pages_resp = await client.get(f"{_GRAPH_BASE}/me/accounts", params={"access_token": user_token})
            pages = pages_resp.json().get("data", []) if pages_resp.status_code == 200 else []
            if not pages:
                return RedirectResponse(_frontend_settings_url("social_error=facebook_no_pages"), status_code=302)

            page = pages[0]
            page_id = page["id"]
            page_token = page.get("access_token", user_token)

            ig_resp = await client.get(f"{_GRAPH_BASE}/{page_id}", params={
                "fields": "instagram_business_account{id,username}",
                "access_token": page_token,
            })
            ig_account = (ig_resp.json().get("instagram_business_account") if ig_resp.status_code == 200 else None) or {}

        await _save_social_account(user_id, "facebook", {
            "pageId": page_id,
            "pageName": page.get("name", ""),
            "accessToken": page_token,
            "instagram": {
                "businessId": ig_account.get("id"),
                "username": ig_account.get("username"),
            },
            "connectedAt": utc_now().isoformat(),
        })
        return RedirectResponse(_frontend_settings_url("social_connected=facebook"), status_code=302)
    except Exception:
        logger.exception("Facebook OAuth callback error for user %s", user_id)
        return RedirectResponse(_frontend_settings_url("social_error=facebook_server_error"), status_code=302)


@router.delete("/facebook")
async def facebook_disconnect(user: CurrentUser = Depends(get_current_user)):
    await _save_social_account(user.sub, "facebook", None)
    return {"platform": "facebook", "disconnected": True}


@router.delete("/{platform}")
async def disconnect_social_platform(platform: str, user: CurrentUser = Depends(get_current_user)):
    normalized = _normalize_platform(platform)
    if normalized not in {"facebook", "linkedin", "twitter"}:
        raise HTTPException(status_code=422, detail="Unsupported social platform.")
    await _save_social_account(user.sub, normalized, None)
    return {"platform": normalized, "disconnected": True}
