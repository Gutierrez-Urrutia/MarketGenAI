"""Schemas for lead contacts (Agente 2 output). Router/service land in Fase 3."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional
from urllib.parse import urlparse

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


class ContactRole(str, Enum):
    HIRING_MANAGER = "hiring_manager"
    HR_RECRUITER = "hr_recruiter"
    DEPARTMENT_HEAD = "department_head"
    PROCUREMENT = "procurement"
    UNKNOWN = "unknown"


class ContactBase(BaseModel):
    """Fields a contact carries before it is attached to a lead: shared by
    ContactCreate and by the enrichment providers' RawContact, so a provider
    result maps onto a ContactCreate field for field.

    Values come from external sources (APIs, scraped pages), so they are
    normalized here: names are stripped, an empty email becomes None, and a
    linkedin_url that is not http(s) is dropped — it is rendered as a link
    later, and a `javascript:` URL must never reach an <a href> (same rule as
    job_scout_service._sanitize_job_url for a lead's job_url)."""

    full_name: str
    job_title: str = ""
    company: str
    email: Optional[str] = None
    linkedin_url: Optional[str] = None
    role: ContactRole = ContactRole.UNKNOWN
    confidence_score: float = Field(0.0, ge=0.0, le=1.0)
    source: str

    @field_validator("full_name", "company", "source")
    @classmethod
    def _required_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be empty")
        return value

    @field_validator("job_title")
    @classmethod
    def _strip_job_title(cls, value: str) -> str:
        return value.strip()

    @field_validator("email")
    @classmethod
    def _blank_email_to_none(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return value.strip() or None

    @field_validator("linkedin_url")
    @classmethod
    def _only_http_linkedin_url(cls, value: Optional[str]) -> Optional[str]:
        value = (value or "").strip()
        try:
            scheme = urlparse(value).scheme.lower()
        except ValueError:  # malformed URL, e.g. "http://[abc": drop the URL, keep the contact
            return None
        if scheme in ("http", "https"):
            return value
        return None


class ContactCreate(ContactBase):
    """A contact to persist for a lead.

    user_id and lead_id are deliberately not fields: user_id comes from the
    session and lead_id from the lead being researched, and both are passed
    to ContactsRepo.create_for_lead. If a body carries them anyway they are
    ignored (extra="ignore"), so they can never override the real ones."""

    model_config = ConfigDict(extra="ignore")

    verified: bool = False


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
