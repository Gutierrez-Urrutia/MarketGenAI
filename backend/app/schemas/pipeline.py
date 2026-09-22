"""Schemas for the prospecting pipeline configuration (Fase 1 — infra only).

Covers PipelineConfig + JobSource (Agente 1 input) and the PipelineRun shape
that will be written by the orchestrator in a later phase. Lead/Contact/
OutreachEmail schemas live in their own modules (lead.py, contact.py,
outreach_email.py).
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SourceType(str, Enum):
    API = "api"
    RSS = "rss"
    SCRAPER = "scraper"
    WEBHOOK = "webhook"


# Fields each source_type needs in `JobSource.config` for /sources/{id}/test
# to consider the source "ready to run". Enforced at the API boundary only —
# no external calls are made yet (that's Fase 2, JobScoutService).
SOURCE_TYPE_REQUIRED_CONFIG_FIELDS: Dict[SourceType, List[str]] = {
    SourceType.API: ["base_url", "api_key"],
    SourceType.RSS: ["feed_url"],
    SourceType.SCRAPER: ["url", "selectors"],
    SourceType.WEBHOOK: [],
}


class JobSource(BaseModel):
    id: str
    name: str
    source_type: SourceType
    enabled: bool = True
    config: Dict[str, Any] = Field(default_factory=dict)
    rate_limit: Optional[int] = None
    last_fetched_at: Optional[datetime] = None


class JobSourceCreate(BaseModel):
    name: str = Field(..., min_length=1)
    source_type: SourceType
    enabled: bool = True
    config: Dict[str, Any] = Field(default_factory=dict)
    rate_limit: Optional[int] = Field(None, ge=1)


class JobSourceUpdate(BaseModel):
    name: Optional[str] = None
    source_type: Optional[SourceType] = None
    enabled: Optional[bool] = None
    config: Optional[Dict[str, Any]] = None
    rate_limit: Optional[int] = Field(None, ge=1)


class PipelineConfig(BaseModel):
    id: str
    user_id: str
    keywords: List[str] = Field(default_factory=list)
    industries: List[str] = Field(default_factory=list)
    excluded_companies: List[str] = Field(default_factory=list)
    sources: List[JobSource] = Field(default_factory=list)

    # Email settings. smtp_password is never returned by the API — see
    # PipelineConfigOut / encryption_service.py.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    sender_email: str = ""
    sender_name: str = ""
    smtp_password_configured: bool = False

    auto_send_threshold: float = Field(0.80, ge=0.0, le=1.0)
    max_emails_per_day: int = Field(50, ge=1)
    scan_frequency_hours: int = Field(24, ge=1)
    is_active: bool = True

    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class PipelineConfigUpdate(BaseModel):
    """PUT /pipeline/config — partial update, smtp_password write-only."""

    keywords: Optional[List[str]] = None
    industries: Optional[List[str]] = None
    excluded_companies: Optional[List[str]] = None

    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = Field(None, ge=1, le=65535)
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    sender_email: Optional[str] = None
    sender_name: Optional[str] = None

    auto_send_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)
    max_emails_per_day: Optional[int] = Field(None, ge=1)
    scan_frequency_hours: Optional[int] = Field(None, ge=1)
    is_active: Optional[bool] = None


class PipelineKeywordsUpdate(BaseModel):
    keywords: List[str] = Field(default_factory=list)
    industries: List[str] = Field(default_factory=list)
    excluded_companies: List[str] = Field(default_factory=list)


class PipelineRunStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PipelineRun(BaseModel):
    id: str
    pipeline_config_id: str
    user_id: str
    status: PipelineRunStatus
    leads_found: int = 0
    leads_new: int = 0
    contacts_found: int = 0
    emails_generated: int = 0
    emails_auto_approved: int = 0
    emails_pending_review: int = 0
    emails_sent: int = 0
    started_at: datetime
    agent1_completed_at: Optional[datetime] = None
    agent2_completed_at: Optional[datetime] = None
    agent3_completed_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    errors: List[Dict[str, Any]] = Field(default_factory=list)
