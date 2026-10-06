"""Schemas for lead contacts (Agente 2 output). Router/service land in Fase 3."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import AliasChoices, BaseModel, Field


class ContactRole(str, Enum):
    HIRING_MANAGER = "hiring_manager"
    HR_RECRUITER = "hr_recruiter"
    DEPARTMENT_HEAD = "department_head"
    PROCUREMENT = "procurement"
    UNKNOWN = "unknown"


class Contact(BaseModel):
    id: str
    lead_id: str
    user_id: str
    full_name: str
    email: Optional[str] = None
    linkedin_url: Optional[str] = None
    job_title: str
    role: ContactRole = ContactRole.UNKNOWN
    company: str
    confidence_score: float = Field(0.0, ge=0.0, le=1.0)
    source: str
    verified: bool = False
    # Firestore stores createdAt/updatedAt (FirestoreRepo.create). Accept both
    # spellings on input only: the JSON key stays created_at/updated_at.
    created_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("created_at", "createdAt"))
    updated_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("updated_at", "updatedAt"))
