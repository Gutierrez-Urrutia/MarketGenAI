"""Schemas for prospecting leads (Agente 1 output). Router/service land in Fase 2."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


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


class RawJobPosting(BaseModel):
    """Intermediate shape returned by a source adapter, before dedup/scoring.
    Never persisted as-is — job_scout_service turns the ones that survive
    dedup + relevance scoring into a Lead."""

    job_title: str
    company_name: str
    job_description: str = ""
    job_url: str = ""
    location: Optional[str] = None
    salary_range: Optional[str] = None
    posted_date: Optional[datetime] = None
    source_id: str


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
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class LeadListResponse(BaseModel):
    items: List[Lead]
    total: int
