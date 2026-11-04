"""Schemas for prospecting leads (Agente 1 output). Router/service land in Fase 2."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import AliasChoices, BaseModel, Field, field_validator


class LeadStatus(str, Enum):
    NEW = "new"
    RESEARCHING = "researching"
    CONTACTS_FOUND = "contacts_found"
    COMPOSING = "composing"
    READY_FOR_REVIEW = "ready_for_review"
    APPROVED = "approved"
    AUTO_APPROVED = "auto_approved"
    SENT = "sent"
    REPLIED = "replied"
    REJECTED = "rejected"
    ERROR = "error"


class ContactsSearchState(str, Enum):
    """Result of the last contact search of a lead (Lead.contacts_search)."""

    RUNNING = "running"
    CONTACTS_FOUND = "contacts_found"
    NO_DOMAIN = "no_domain"        # neither a domain nor a company name: no request made
    NO_CONTACTS = "no_contacts"
    ERROR = "error"


class ContactsSearch(BaseModel):
    """The last contact search of a lead (RF15). `reason` is a code
    (no_credits, invalid_api_key, timeout...), never free text. `domain` is
    the domain actually searched: the lead's, or the one Hunter resolved from
    the company name (company_domain is never overwritten)."""

    state: ContactsSearchState
    search_id: Optional[str] = None
    started_at: Optional[datetime] = None
    searched_at: Optional[datetime] = None
    reason: Optional[str] = None
    domain: Optional[str] = None
    domain_source: Optional[str] = None   # "lead" | "hunter_company_search"
    query_type: Optional[str] = None      # "domain" | "company" | "reuse"
    vacancy_area: Optional[str] = None
    contacts_count: int = 0
    credits_used: float = 0.0
    forced: bool = False
    reused_from_lead_id: Optional[str] = None


class RawJobPosting(BaseModel):
    """Intermediate shape returned by a source adapter, before dedup/scoring.
    Never persisted as-is — job_scout_service turns the ones that survive
    dedup + relevance scoring into a Lead.

    job_title is required (empty/whitespace-only is rejected); company_name
    may be empty when the source doesn't say who is hiring. raw_title is the
    unsplit entry title, only set by the RSS adapter."""

    job_title: str
    company_name: str
    job_description: str = ""
    job_url: str = ""
    location: Optional[str] = None
    salary_range: Optional[str] = None
    posted_date: Optional[datetime] = None
    source_id: str
    raw_title: Optional[str] = None
    company_domain: Optional[str] = None
    company_domain_source: Optional[str] = None
    source_job_id: Optional[str] = None

    @field_validator("job_title")
    @classmethod
    def _job_title_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("job_title must not be empty")
        return value


class Lead(BaseModel):
    id: str
    pipeline_config_id: str
    user_id: str
    job_title: str
    company_name: str
    job_description: str
    job_url: str
    source_id: str
    location: Optional[str] = None
    salary_range: Optional[str] = None
    posted_date: Optional[datetime] = None
    matched_keywords: List[str] = Field(default_factory=list)
    relevance_score: float = Field(0.0, ge=0.0, le=1.0)
    status: LeadStatus = LeadStatus.NEW
    pipeline_run_id: str
    fingerprint: str
    raw_title: Optional[str] = None
    # Company's registrable domain and where it came from ("rss_url_line",
    # "jsearch_employer_website"); None on leads saved before T9a and on
    # postings without one.
    company_domain: Optional[str] = None
    company_domain_source: Optional[str] = None
    # The posting's id at its provider (JSearch `job_id`); None on other
    # sources and on leads saved before RF15. Not part of the fingerprint.
    source_job_id: Optional[str] = None
    # Last contact search (RF15, Fase 5); None until the first one.
    contacts_search: Optional[ContactsSearch] = None
    # Firestore stores createdAt/updatedAt (FirestoreRepo.create). Accept both
    # spellings on input only: the JSON key stays created_at/updated_at.
    created_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("created_at", "createdAt"))
    updated_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("updated_at", "updatedAt"))


class LeadListResponse(BaseModel):
    items: List[Lead]
    total: int
