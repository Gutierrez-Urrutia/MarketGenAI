"""CRM integration clients.

Only HubSpot is implemented today. Other providers are rejected by the
routers before this module is ever reached.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

import httpx

from app.config import settings

_TIMEOUT = 8


class CrmError(Exception):
    """Base class for CRM integration failures."""


class CrmAuthError(CrmError):
    """The stored API key was rejected by the CRM provider."""


class CrmTimeoutError(CrmError):
    """The CRM provider did not respond in time."""


class CrmProviderError(CrmError):
    """The CRM provider returned an unexpected error."""


def _split_name(name: Optional[str]) -> tuple[str, str]:
    parts = (name or "").strip().split(" ", 1)
    if not parts or not parts[0]:
        return "", ""
    return parts[0], parts[1] if len(parts) > 1 else ""


class HubSpotClient:
    def __init__(self, api_key: str, base_url: Optional[str] = None):
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._base_url = (base_url or settings.hubspot_base_url).rstrip("/")

    async def test_connection(self) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                resp = await client.get(
                    f"{self._base_url}/crm/v3/objects/contacts",
                    params={"limit": 1},
                    headers=self._headers,
                )
            except httpx.TimeoutException as exc:
                raise CrmTimeoutError("Timeout al conectar con HubSpot") from exc
        if resp.status_code == 200:
            return {"status": "connected", "message": "Conexión exitosa con HubSpot"}
        if resp.status_code == 401:
            raise CrmAuthError("API key inválida o sin permisos")
        raise CrmProviderError(f"HubSpot respondió con error {resp.status_code}")

    async def upsert_contact(
        self, *, email: str, name: Optional[str] = None, company: Optional[str] = None
    ) -> str:
        firstname, lastname = _split_name(name)
        properties: Dict[str, Any] = {"email": email}
        if firstname:
            properties["firstname"] = firstname
        if lastname:
            properties["lastname"] = lastname
        if company:
            properties["company"] = company

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                search_resp = await client.post(
                    f"{self._base_url}/crm/v3/objects/contacts/search",
                    headers=self._headers,
                    json={
                        "filterGroups": [
                            {"filters": [{"propertyName": "email", "operator": "EQ", "value": email}]}
                        ],
                        "limit": 1,
                    },
                )
                self._raise_for_status(search_resp)
                results = search_resp.json().get("results") or []

                if results:
                    contact_id = results[0]["id"]
                    update_resp = await client.patch(
                        f"{self._base_url}/crm/v3/objects/contacts/{contact_id}",
                        headers=self._headers,
                        json={"properties": properties},
                    )
                    self._raise_for_status(update_resp)
                    return contact_id

                create_resp = await client.post(
                    f"{self._base_url}/crm/v3/objects/contacts",
                    headers=self._headers,
                    json={"properties": properties},
                )
                self._raise_for_status(create_resp)
                return create_resp.json()["id"]
            except httpx.TimeoutException as exc:
                raise CrmTimeoutError("Timeout al conectar con HubSpot") from exc

    async def upsert_deal(
        self,
        *,
        deal_id: Optional[str],
        dealname: Optional[str],
        amount: Optional[float],
        contact_id: str,
    ) -> str:
        properties: Dict[str, Any] = {"dealname": dealname or "Untitled proposal"}
        if amount is not None:
            properties["amount"] = str(amount)

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                if deal_id:
                    update_resp = await client.patch(
                        f"{self._base_url}/crm/v3/objects/deals/{deal_id}",
                        headers=self._headers,
                        json={"properties": properties},
                    )
                    self._raise_for_status(update_resp)
                else:
                    create_resp = await client.post(
                        f"{self._base_url}/crm/v3/objects/deals",
                        headers=self._headers,
                        json={"properties": properties},
                    )
                    self._raise_for_status(create_resp)
                    deal_id = create_resp.json()["id"]

                assoc_resp = await client.put(
                    f"{self._base_url}/crm/v4/objects/deals/{deal_id}/associations/default/contacts/{contact_id}",
                    headers=self._headers,
                )
                self._raise_for_status(assoc_resp)
                return deal_id
            except httpx.TimeoutException as exc:
                raise CrmTimeoutError("Timeout al conectar con HubSpot") from exc

    def _raise_for_status(self, resp: httpx.Response) -> None:
        if resp.status_code < 400:
            return
        if resp.status_code == 401:
            raise CrmAuthError("API key inválida o sin permisos")
        try:
            detail = resp.json().get("message", resp.text)
        except ValueError:
            detail = resp.text
        raise CrmProviderError(f"HubSpot respondió con error {resp.status_code}: {detail}")
