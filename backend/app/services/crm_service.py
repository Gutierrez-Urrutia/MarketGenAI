"""CRM integration clients.

Only HubSpot is implemented today. Other providers are rejected by the
routers before this module is ever reached.
"""
from __future__ import annotations

from datetime import date, timedelta
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


def _soql_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


class SalesforceClient:
    """OAuth 2.0 Client Credentials flow — see Connected App setup in Settings.

    Unlike HubSpotClient's static bearer token, every call here needs a fresh
    access token exchanged against `login_url`. The token is cached on the
    instance (not persisted) since a new client is created per request, so
    the 3 upserts of a single send-to-crm call share one token.
    """

    def __init__(self, consumer_key: str, consumer_secret: str, login_url: str):
        self._consumer_key = consumer_key
        self._consumer_secret = consumer_secret
        self._login_url = login_url.rstrip("/")
        self._access_token: Optional[str] = None
        self._instance_url: Optional[str] = None

    async def _authenticate(self) -> None:
        if self._access_token and self._instance_url:
            return
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                resp = await client.post(
                    f"{self._login_url}/services/oauth2/token",
                    data={
                        "grant_type": "client_credentials",
                        "client_id": self._consumer_key,
                        "client_secret": self._consumer_secret,
                    },
                )
            except httpx.TimeoutException as exc:
                raise CrmTimeoutError("Timeout al conectar con Salesforce") from exc
        if resp.status_code != 200:
            try:
                error = resp.json().get("error", "")
            except ValueError:
                error = ""
            if error in ("invalid_client", "invalid_grant", "invalid_client_id"):
                raise CrmAuthError("Consumer Key/Secret inválidos o sin permisos")
            raise CrmProviderError(f"Salesforce respondió con error {resp.status_code}: {resp.text}")
        payload = resp.json()
        self._access_token = payload["access_token"]
        self._instance_url = payload["instance_url"].rstrip("/")

    @property
    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self._access_token}", "Content-Type": "application/json"}

    def _url(self, path: str) -> str:
        return f"{self._instance_url}/services/data/{settings.salesforce_api_version}{path}"

    async def _query_one(self, client: httpx.AsyncClient, soql: str) -> Optional[Dict[str, Any]]:
        resp = await client.get(self._url("/query"), headers=self._headers, params={"q": soql})
        self._raise_for_status(resp)
        records = resp.json().get("records") or []
        return records[0] if records else None

    async def test_connection(self) -> Dict[str, Any]:
        await self._authenticate()
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                resp = await client.get(
                    self._url("/query"),
                    headers=self._headers,
                    params={"q": "SELECT Id FROM Contact LIMIT 1"},
                )
            except httpx.TimeoutException as exc:
                raise CrmTimeoutError("Timeout al conectar con Salesforce") from exc
        self._raise_for_status(resp)
        return {"status": "connected", "message": "Conexión exitosa con Salesforce"}

    async def upsert_account(self, name: str) -> str:
        await self._authenticate()
        safe_name = _soql_escape(name)
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                existing = await self._query_one(
                    client, f"SELECT Id FROM Account WHERE Name = '{safe_name}' LIMIT 1"
                )
                if existing:
                    return existing["Id"]
                create_resp = await client.post(
                    self._url("/sobjects/Account"), headers=self._headers, json={"Name": name},
                )
                self._raise_for_status(create_resp)
                return create_resp.json()["id"]
            except httpx.TimeoutException as exc:
                raise CrmTimeoutError("Timeout al conectar con Salesforce") from exc

    async def upsert_contact(self, *, email: str, name: Optional[str], account_id: str) -> str:
        await self._authenticate()
        firstname, lastname = _split_name(name)
        if not lastname:
            # Contact.LastName is mandatory in Salesforce, unlike HubSpot —
            # fall back to whatever single token we have, then the email.
            lastname = firstname or email.split("@")[0] or "Cliente"
            firstname = ""
        safe_email = _soql_escape(email)
        properties: Dict[str, Any] = {"LastName": lastname, "Email": email, "AccountId": account_id}
        if firstname:
            properties["FirstName"] = firstname

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                existing = await self._query_one(
                    client, f"SELECT Id FROM Contact WHERE Email = '{safe_email}' LIMIT 1"
                )
                if existing:
                    contact_id = existing["Id"]
                    update_resp = await client.patch(
                        self._url(f"/sobjects/Contact/{contact_id}"), headers=self._headers, json=properties,
                    )
                    self._raise_for_status(update_resp)
                    return contact_id
                create_resp = await client.post(
                    self._url("/sobjects/Contact"), headers=self._headers, json=properties,
                )
                self._raise_for_status(create_resp)
                return create_resp.json()["id"]
            except httpx.TimeoutException as exc:
                raise CrmTimeoutError("Timeout al conectar con Salesforce") from exc

    async def upsert_opportunity(
        self,
        *,
        opportunity_id: Optional[str],
        name: Optional[str],
        amount: Optional[float],
        account_id: str,
        contact_id: str,
    ) -> str:
        await self._authenticate()
        properties: Dict[str, Any] = {"Name": name or "Untitled proposal"}
        if amount is not None:
            properties["Amount"] = amount

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                if opportunity_id:
                    update_resp = await client.patch(
                        self._url(f"/sobjects/Opportunity/{opportunity_id}"), headers=self._headers, json=properties,
                    )
                    self._raise_for_status(update_resp)
                else:
                    properties["AccountId"] = account_id
                    properties["StageName"] = "Proposal/Price Quote"
                    properties["CloseDate"] = (date.today() + timedelta(days=30)).isoformat()
                    create_resp = await client.post(
                        self._url("/sobjects/Opportunity"), headers=self._headers, json=properties,
                    )
                    self._raise_for_status(create_resp)
                    opportunity_id = create_resp.json()["id"]

                # Best-effort: link the contact via the junction object. Not
                # critical to the sync, so a failure here (e.g. the role
                # already exists) shouldn't fail the whole request.
                try:
                    await client.post(
                        self._url("/sobjects/OpportunityContactRole"),
                        headers=self._headers,
                        json={"OpportunityId": opportunity_id, "ContactId": contact_id, "IsPrimary": True},
                    )
                except httpx.TimeoutException:
                    pass
                return opportunity_id
            except httpx.TimeoutException as exc:
                raise CrmTimeoutError("Timeout al conectar con Salesforce") from exc

    def _raise_for_status(self, resp: httpx.Response) -> None:
        if resp.status_code < 400:
            return
        if resp.status_code == 401:
            raise CrmAuthError("Token de Salesforce inválido o expirado")
        try:
            body = resp.json()
            if isinstance(body, list) and body:
                detail = body[0].get("message", resp.text)
            elif isinstance(body, dict):
                detail = body.get("message", resp.text)
            else:
                detail = resp.text
        except ValueError:
            detail = resp.text
        raise CrmProviderError(f"Salesforce respondió con error {resp.status_code}: {detail}")
