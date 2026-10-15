"""Settings router — per-org configuration (CRM, LLM model, social)."""
from __future__ import annotations

from datetime import datetime, timezone as tz
from typing import Any, Dict, List, Optional

from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.crm import (
    CrmActiveProviderUpdate,
    CrmConnectionSaveRequest,
    CrmTestConnectionRequest,
)
from app.services import crm_service, encryption_service
from app.services.crm_service import (
    CrmAuthError,
    CrmProviderError,
    CrmTimeoutError,
    HubSpotClient,
    SalesforceClient,
)
from app.services.firestore_service import settings_repo

router = APIRouter(prefix="/settings", tags=["Settings"])

_CRM_PROVIDERS = ("hubspot", "salesforce")


class SettingsUpdate(BaseModel):
    language:           Optional[str] = None
    theme:              Optional[str] = None
    timezone:           Optional[str] = None
    dateFormat:         Optional[str] = None
    llm:                Optional[Dict[str, Any]] = None
    socialConnections:  Optional[List[str]] = None


def _redact_social_tokens(doc: Dict[str, Any]) -> Dict[str, Any]:
    """socialAccounts.* holds raw provider access tokens (see social.py) —
    never let this generic settings read leak them back to the browser."""
    accounts = doc.get("socialAccounts")
    if not isinstance(accounts, dict):
        return doc
    redacted = {
        platform: {key: value for key, value in data.items() if key != "accessToken"}
        for platform, data in accounts.items()
        if isinstance(data, dict)
    }
    return {**doc, "socialAccounts": redacted}


def _encrypt_secret(value: str) -> str:
    try:
        return encryption_service.encrypt(value)
    except encryption_service.EncryptionNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _decrypt_secret(token: str) -> str:
    try:
        return encryption_service.decrypt(token)
    except encryption_service.EncryptionNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except InvalidToken as exc:
        raise HTTPException(
            status_code=409,
            detail="Las credenciales guardadas no se pueden descifrar (la clave de cifrado cambió). Vuelve a ingresarlas.",
        ) from exc


def _is_placeholder(value: Optional[str]) -> bool:
    return bool(value) and value.startswith("••••")


async def _get_crm(user_id: str) -> Dict[str, Any]:
    doc = await settings_repo.get(user_id)
    return (doc or {}).get("crm") or {}


async def _save_crm(user_id: str, crm: Dict[str, Any]) -> Dict[str, Any]:
    existing = await settings_repo.get(user_id)
    payload = {"crm": crm, "userId": user_id}
    if existing:
        return await settings_repo.update(user_id, payload)
    return await settings_repo.create(payload, doc_id=user_id)


def _crm_connection_status(provider: str, connections: Dict[str, Any]) -> Dict[str, Any]:
    """Redacted view of one provider's stored connection — last4 + metadata,
    never the encrypted blob or plaintext secret."""
    connection = connections.get(provider) or {}
    if provider == "hubspot":
        connected = bool(connection.get("apiKeyEncrypted"))
        return {
            "connected": connected,
            "provider": provider,
            "apiKeyLast4": connection.get("apiKeyLast4"),
            "connectedAt": connection.get("connectedAt"),
        }
    connected = bool(connection.get("consumerKeyEncrypted") and connection.get("consumerSecretEncrypted"))
    return {
        "connected": connected,
        "provider": provider,
        "consumerKeyLast4": connection.get("consumerKeyLast4"),
        "consumerSecretLast4": connection.get("consumerSecretLast4"),
        "loginUrl": connection.get("loginUrl"),
        "connectedAt": connection.get("connectedAt"),
    }


def _crm_public_status(crm: Dict[str, Any]) -> Dict[str, Any]:
    connections = crm.get("connections") or {}
    return {
        "activeProvider": crm.get("activeProvider") or "none",
        "connections": {
            provider: _crm_connection_status(provider, connections) for provider in _CRM_PROVIDERS
        },
    }


@router.get("")
async def get_settings(user: CurrentUser = Depends(get_current_user)):
    """Return the current org settings (keyed by user.sub)."""
    doc = await settings_repo.get_by_user(user.sub)
    doc = _redact_social_tokens(doc)
    return {**doc, "crm": _crm_public_status(doc.get("crm") or {})}


@router.get("/crm/status")
async def crm_status(user: CurrentUser = Depends(get_current_user)):
    return _crm_public_status(await _get_crm(user.sub))


@router.post("/crm/test-connection")
async def test_crm_connection(
    body: CrmTestConnectionRequest,
    user: CurrentUser = Depends(get_current_user),
):
    provider = body.provider
    connections = (await _get_crm(user.sub)).get("connections") or {}
    stored = connections.get(provider) or {}

    try:
        if provider == "hubspot":
            api_key = (body.apiKey or "").strip()
            if _is_placeholder(api_key):
                encrypted = stored.get("apiKeyEncrypted")
                api_key = _decrypt_secret(encrypted) if encrypted else ""
            if not api_key:
                raise HTTPException(status_code=400, detail="API key requerida")
            return await HubSpotClient(api_key).test_connection()

        consumer_key = (body.consumerKey or "").strip()
        consumer_secret = (body.consumerSecret or "").strip()
        login_url = (body.loginUrl or "").strip()
        if _is_placeholder(consumer_key):
            encrypted = stored.get("consumerKeyEncrypted")
            consumer_key = _decrypt_secret(encrypted) if encrypted else ""
        if _is_placeholder(consumer_secret):
            encrypted = stored.get("consumerSecretEncrypted")
            consumer_secret = _decrypt_secret(encrypted) if encrypted else ""
        if not consumer_key or not consumer_secret or not login_url:
            raise HTTPException(
                status_code=400,
                detail="Consumer Key, Consumer Secret y Login URL son requeridos",
            )
        return await SalesforceClient(consumer_key, consumer_secret, login_url).test_connection()
    except CrmAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except CrmTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CrmProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/crm/{provider}/connect")
async def connect_crm_provider(
    provider: str,
    body: CrmConnectionSaveRequest,
    user: CurrentUser = Depends(get_current_user),
):
    if provider not in _CRM_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Proveedor '{provider}' no soportado aún")

    if provider == "hubspot":
        api_key = (body.apiKey or "").strip()
        if not api_key:
            raise HTTPException(status_code=400, detail="API key requerida")
    else:
        consumer_key = (body.consumerKey or "").strip()
        consumer_secret = (body.consumerSecret or "").strip()
        login_url = (body.loginUrl or "").strip()
        if not consumer_key or not consumer_secret or not login_url:
            raise HTTPException(
                status_code=400,
                detail="Consumer Key, Consumer Secret y Login URL son requeridos",
            )

    crm = await _get_crm(user.sub)
    connections = dict(crm.get("connections") or {})
    existing = connections.get(provider) or {}
    now = datetime.now(tz.utc).isoformat()

    if provider == "hubspot":
        if _is_placeholder(api_key):
            connections[provider] = {**existing, "connectedAt": now}
        else:
            connections[provider] = {
                "apiKeyEncrypted": _encrypt_secret(api_key),
                "apiKeyLast4": api_key[-4:] if len(api_key) >= 4 else api_key,
                "connectedAt": now,
            }
    else:
        new_connection = dict(existing)
        new_connection["loginUrl"] = login_url
        new_connection["connectedAt"] = now
        if _is_placeholder(consumer_key):
            pass
        else:
            new_connection["consumerKeyEncrypted"] = _encrypt_secret(consumer_key)
            new_connection["consumerKeyLast4"] = consumer_key[-4:] if len(consumer_key) >= 4 else consumer_key
        if _is_placeholder(consumer_secret):
            pass
        else:
            new_connection["consumerSecretEncrypted"] = _encrypt_secret(consumer_secret)
            new_connection["consumerSecretLast4"] = consumer_secret[-4:] if len(consumer_secret) >= 4 else consumer_secret
        connections[provider] = new_connection

    crm["connections"] = connections
    await _save_crm(user.sub, crm)
    return _crm_public_status(crm)


@router.delete("/crm/{provider}")
async def disconnect_crm_provider(provider: str, user: CurrentUser = Depends(get_current_user)):
    if provider not in _CRM_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Proveedor '{provider}' no soportado aún")

    crm = await _get_crm(user.sub)
    connections = dict(crm.get("connections") or {})
    connections.pop(provider, None)
    crm["connections"] = connections
    if crm.get("activeProvider") == provider:
        crm["activeProvider"] = "none"
    await _save_crm(user.sub, crm)
    return _crm_public_status(crm)


@router.put("/crm/active-provider")
async def set_active_crm_provider(
    body: CrmActiveProviderUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    crm = await _get_crm(user.sub)
    connections = crm.get("connections") or {}
    if body.activeProvider != "none" and not connections.get(body.activeProvider):
        raise HTTPException(
            status_code=400,
            detail=f"'{body.activeProvider}' no tiene credenciales guardadas todavía.",
        )
    crm["activeProvider"] = body.activeProvider
    await _save_crm(user.sub, crm)
    return _crm_public_status(crm)


@router.put("")
async def update_settings(
    body: SettingsUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    """Upsert org settings. CRM is managed exclusively via the /settings/crm/*
    endpoints above, not through this generic endpoint — same separation
    social.py already uses for socialAccounts."""
    existing = await settings_repo.get(user.sub)
    payload = body.model_dump(exclude_none=True)
    payload["userId"] = user.sub

    if existing:
        return await settings_repo.update(user.sub, payload)
    else:
        return await settings_repo.create(payload, doc_id=user.sub)
