"""Schemas for lead contacts (Agente 2 output). Router/service land in Fase 3;
the provider-reported email fields (email_type, verification, sources) in RF15."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import List, Literal, Optional
from urllib.parse import urlparse

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


class ContactRole(str, Enum):
    HIRING_MANAGER = "hiring_manager"
    HR_RECRUITER = "hr_recruiter"
    DEPARTMENT_HEAD = "department_head"
    PROCUREMENT = "procurement"
    EXECUTIVE = "executive"  # CEO / founder / owner (RF15)
    UNKNOWN = "unknown"


EmailType = Literal["personal", "generic"]


def http_url_or_none(value: Optional[str]) -> Optional[str]:
    """`value` stripped when it is an http(s) URL, else None (also for a
    malformed URL such as "http://[abc"). Never raises."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    try:
        scheme = urlparse(value).scheme.lower()
    except ValueError:
        return None
    if scheme in ("http", "https"):
        return value
    return None


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
    # What the provider reports about the address (RF15). email_verification_status
    # is the provider's own check (Hunter: valid / accept_all / unknown), not
    # ContactCreate.verified, which is this system's own verification.
    email_type: Optional[EmailType] = None
    email_verification_status: Optional[str] = None
    email_verified_at: Optional[datetime] = None
    seniority: Optional[str] = None
    department: Optional[str] = None
    # Public pages where the provider found the address (http/https only).
    source_urls: List[str] = Field(default_factory=list)
    source_last_seen_at: Optional[datetime] = None
    # confidence_score is the ranked (adjusted) confidence; this is the
    # provider's own, before any adjustment. None on contacts saved before RF15.
    provider_confidence_score: Optional[float] = Field(None, ge=0.0, le=1.0)
    # Where email_verification_status came from ("hunter_domain_search",
    # "hunter_email_verifier"); None when there is no status.
    email_verification_source: Optional[str] = None

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
        # A malformed URL, e.g. "http://[abc", drops the URL, not the contact.
        return http_url_or_none(value)

    @field_validator("email_verification_status", "seniority", "department", "email_verification_source")
    @classmethod
    def _blank_text_to_none(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return value.strip() or None

    @field_validator("source_urls")
    @classmethod
    def _only_http_source_urls(cls, value: List[str]) -> List[str]:
        return [url for url in (http_url_or_none(item) for item in value) if url]


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
    # None / empty on contacts saved before RF15.
    email_type: Optional[EmailType] = None
    email_verification_status: Optional[str] = None
    email_verified_at: Optional[datetime] = None
    seniority: Optional[str] = None
    department: Optional[str] = None
    source_urls: List[str] = Field(default_factory=list)
    source_last_seen_at: Optional[datetime] = None
    provider_confidence_score: Optional[float] = Field(None, ge=0.0, le=1.0)
    email_verification_source: Optional[str] = None
    # Firestore stores createdAt/updatedAt (FirestoreRepo.create). Accept both
    # spellings on input only: the JSON key stays created_at/updated_at.
    created_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("created_at", "createdAt"))
    updated_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("updated_at", "updatedAt"))
