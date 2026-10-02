"""Settings router — per-org configuration (CRM, LLM model, social)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

from app.dependencies.auth import CurrentUser, get_current_user
from app.services.crm_service import (
    CrmAuthError,
    CrmProviderError,
    CrmTimeoutError,
    HubSpotClient,
    SalesforceClient,
)
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


def _redact_secret(value: str) -> str:
    return f"••••{value[-4:]}" if len(value) >= 4 else "••••"


def _redact_crm_key(doc: Dict[str, Any]) -> Dict[str, Any]:
    """crm.apiKey (HubSpot) and crm.salesforce.{consumerKey,consumerSecret}
    hold raw CRM provider credentials — never return them in clear text;
    expose only whether one is configured plus a display hint."""
    crm = doc.get("crm")
    if not isinstance(crm, dict):
        return doc
    redacted = dict(crm)
    if crm.get("apiKey"):
        redacted["apiKey"] = _redact_secret(crm["apiKey"])
        redacted["hasApiKey"] = True
    salesforce = crm.get("salesforce")
    if isinstance(salesforce, dict):
        redacted_sf = dict(salesforce)
        if salesforce.get("consumerKey"):
            redacted_sf["consumerKey"] = _redact_secret(salesforce["consumerKey"])
            redacted_sf["hasConsumerKey"] = True
        if salesforce.get("consumerSecret"):
            redacted_sf["consumerSecret"] = _redact_secret(salesforce["consumerSecret"])
            redacted_sf["hasConsumerSecret"] = True
        redacted["salesforce"] = redacted_sf
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
    provider = body.get("provider", "hubspot").lower()

    try:
        if provider == "hubspot":
            api_key = body.get("apiKey", "").strip()
            if not api_key:
                raise HTTPException(status_code=400, detail="API key requerida")
            return await HubSpotClient(api_key).test_connection()

        if provider == "salesforce":
            consumer_key = (body.get("consumerKey") or "").strip()
            consumer_secret = (body.get("consumerSecret") or "").strip()
            login_url = (body.get("loginUrl") or "").strip()
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

    raise HTTPException(status_code=400, detail=f"Proveedor '{provider}' no soportado aún")


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
        if "salesforce" in payload["crm"]:
            existing_sf = existing_crm.get("salesforce") or {}
            merged_sf = {**existing_sf, **payload["crm"]["salesforce"]}
            if merged_sf.get("consumerKey", "").startswith("••••"):
                merged_sf["consumerKey"] = existing_sf.get("consumerKey", "")
            if merged_sf.get("consumerSecret", "").startswith("••••"):
                merged_sf["consumerSecret"] = existing_sf.get("consumerSecret", "")
            merged_crm["salesforce"] = merged_sf
        payload["crm"] = merged_crm

    if existing:
        return await settings_repo.update(user.sub, payload)
    else:
        return await settings_repo.create(payload, doc_id=user.sub)
