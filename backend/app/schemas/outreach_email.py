"""Schemas for pipeline-generated outreach emails (Agente 3 output).

Named `outreach_email` (not `outreach`) and backed by its own Firestore
collection `outreach_emails` — distinct from the existing `outreach`
collection used by routers/outreach.py (AI response review queue), which
predates this pipeline and serves a different workflow. Router/service for
this schema land in Fase 4/5.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class EmailStatus(str, Enum):
    DRAFT = "draft"
    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    AUTO_APPROVED = "auto_approved"
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"
    BOUNCED = "bounced"
    OPENED = "opened"
    REPLIED = "replied"


class OutreachEmail(BaseModel):
    id: str
    lead_id: str
    contact_id: str
    user_id: str
    subject: str
    body_html: str
    body_plain: str
    personalization_notes: str = ""
    value_proposition: str = ""
    confidence_score: float = Field(0.0, ge=0.0, le=1.0)
    auto_approved: bool = False
    status: EmailStatus = EmailStatus.DRAFT
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    open_count: int = 0
    reply_received: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
