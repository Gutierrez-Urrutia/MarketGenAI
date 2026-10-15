"""Typed request/response shapes for CRM integration settings."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

CrmProvider = Literal["hubspot", "salesforce"]
ActiveCrmProvider = Literal["hubspot", "salesforce", "none"]


class CrmTestConnectionRequest(BaseModel):
    provider: CrmProvider
    apiKey: Optional[str] = None
    consumerKey: Optional[str] = None
    consumerSecret: Optional[str] = None
    loginUrl: Optional[str] = None


class CrmConnectionSaveRequest(BaseModel):
    apiKey: Optional[str] = None
    consumerKey: Optional[str] = None
    consumerSecret: Optional[str] = None
    loginUrl: Optional[str] = None


class CrmActiveProviderUpdate(BaseModel):
    activeProvider: ActiveCrmProvider
