"""Settings router — per-org configuration (CRM, LLM model, social)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

from app.dependencies.auth import CurrentUser, get_current_user
from app.services.crm_service import CrmAuthError, CrmProviderError, CrmTimeoutError, HubSpotClient
from app.services.firestore_service import settings_repo

router = APIRouter(prefix="/settings", tags=["Settings"])


class SettingsUpdate(BaseModel):
    language:           Optional[str] = None
    theme:              Optional[str] = None
    timezone:           Optional[str] = None
    dateFormat:         Optional[str] = None
    llm:                Optional[Dict[str, Any]] = None
    crm:                Optional[Dict[str, Any]] = None
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


def _redact_crm_key(doc: Dict[str, Any]) -> Dict[str, Any]:
    """crm.apiKey holds a raw CRM provider API key — never return it in
    clear text; expose only whether one is configured plus a display hint."""
    crm = doc.get("crm")
    if not isinstance(crm, dict) or not crm.get("apiKey"):
        return doc
    api_key = crm["apiKey"]
    redacted = {**crm, "apiKey": f"••••{api_key[-4:]}", "hasApiKey": True}
    return {**doc, "crm": redacted}


@router.get("")
async def get_settings(user: CurrentUser = Depends(get_current_user)):
    """Return the current org settings (keyed by user.sub)."""
    doc = await settings_repo.get_by_user(user.sub)
    return _redact_crm_key(_redact_social_tokens(doc))


@router.post("/crm/test-connection")
async def test_crm_connection(
    body: dict,
    user: CurrentUser = Depends(get_current_user),
):
    api_key = body.get("apiKey", "").strip()
    provider = body.get("provider", "hubspot").lower()
    if not api_key:
        raise HTTPException(status_code=400, detail="API key requerida")
    if provider != "hubspot":
        raise HTTPException(status_code=400, detail=f"Proveedor '{provider}' no soportado aún")

    try:
        return await HubSpotClient(api_key).test_connection()
    except CrmAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except CrmTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CrmProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.put("")
async def update_settings(
    body: SettingsUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    """Upsert org settings."""
    existing = await settings_repo.get(user.sub)
    payload = body.model_dump(exclude_none=True)
    payload["userId"] = user.sub

    # Firestore's update() replaces the whole `crm` map with whatever is
    # passed here — merge onto the previously stored map so saving just
    # {provider: ...} (e.g. from the general Preferences save) doesn't wipe
    # out a separately-saved apiKey, and vice versa. If the client
    # round-tripped the redacted "••••1234" placeholder from GET /settings
    # unchanged, keep the real stored key instead of overwriting it.
    if "crm" in payload:
        existing_crm = (existing or {}).get("crm") or {}
        merged_crm = {**existing_crm, **payload["crm"]}
        if merged_crm.get("apiKey", "").startswith("••••"):
            merged_crm["apiKey"] = existing_crm.get("apiKey", "")
        payload["crm"] = merged_crm

    if existing:
        return await settings_repo.update(user.sub, payload)
    else:
        return await settings_repo.create(payload, doc_id=user.sub)
