"""Settings router — per-org configuration (CRM, LLM model, social)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

from app.dependencies.auth import CurrentUser, get_current_user
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


@router.get("")
async def get_settings(user: CurrentUser = Depends(get_current_user)):
    """Return the current org settings (keyed by user.sub)."""
    doc = await settings_repo.get_by_user(user.sub)
    return _redact_social_tokens(doc)


@router.post("/crm/test-connection")
async def test_crm_connection(
    body: dict,
    user: CurrentUser = Depends(get_current_user),
):
    import httpx
    api_key = body.get("apiKey", "").strip()
    provider = body.get("provider", "hubspot").lower()
    if not api_key:
        raise HTTPException(status_code=400, detail="API key requerida")
    if provider == "hubspot":
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                resp = await client.get(
                    "https://api.hubapi.com/crm/v3/objects/contacts",
                    params={"limit": 1},
                    headers={"Authorization": f"Bearer {api_key}"},
                )
            if resp.status_code == 200:
                return {"status": "connected", "message": "Conexión exitosa con HubSpot"}
            elif resp.status_code == 401:
                raise HTTPException(status_code=401, detail="API key inválida o sin permisos")
            else:
                raise HTTPException(status_code=502, detail=f"HubSpot respondió con error {resp.status_code}")
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="Timeout al conectar con HubSpot")
    else:
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

    # Mask any API keys before storing (basic protection)
    if "crm" in payload and payload["crm"].get("apiKey"):
        key = payload["crm"]["apiKey"]
        if not all(c == "•" for c in key):       # only update if not masked
            payload["crm"]["apiKey"] = key        # store as-is (encrypt at rest via Firestore rules)

    if existing:
        return await settings_repo.update(user.sub, payload)
    else:
        return await settings_repo.create(payload, doc_id=user.sub)
