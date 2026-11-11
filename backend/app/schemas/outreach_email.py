"""Schemas for prospecting emails (Agente 3, RF-VTA-16).

Named `outreach_email` (not `outreach`) and backed by its own Firestore
collection `outreach_emails` — distinct from the `outreach` collection used by
routers/outreach.py (AI response review queue), which serves a different
workflow and is not touched by this one.

An email is written for one contact of one lead and goes through review:

    pending_review → approved → sent
    pending_review | approved → rejected

`sent` is only a mark (the user sent it by other means): nothing is ever sent
from here. `sent` and `rejected` are final; a rejected email no longer counts
as active, so a new one may be written for the same contact. Every decision is
appended to the email's `history`, and a regeneration keeps the previous
subject and body there.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from app.schemas.lead import LeadStatus


class EmailStatus(str, Enum):
    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    SENT = "sent"
    REJECTED = "rejected"


EmailAction = Literal["generate", "regenerate", "approve", "reject", "mark_sent"]

# Statuses that make an email the contact's active one (at most one per contact).
ACTIVE_EMAIL_STATUSES = (EmailStatus.PENDING_REVIEW.value, EmailStatus.APPROVED.value)

# action → (statuses it may be applied to, status afterwards). `generate`
# creates the email, so it has no "from" status.
EMAIL_TRANSITIONS: Dict[str, tuple] = {
    "regenerate": ((EmailStatus.PENDING_REVIEW.value,), EmailStatus.PENDING_REVIEW.value),
    "approve": ((EmailStatus.PENDING_REVIEW.value,), EmailStatus.APPROVED.value),
    "reject": ((EmailStatus.PENDING_REVIEW.value, EmailStatus.APPROVED.value), EmailStatus.REJECTED.value),
    "mark_sent": ((EmailStatus.APPROVED.value,), EmailStatus.SENT.value),
}

# action → contact review statuses that block it. A contact that still needs
# review (pending) may get an email written, but the email cannot be approved
# until the contact is reviewed; a rejected contact blocks everything.
CONTACT_REVIEW_BLOCKS: Dict[str, tuple] = {
    "generate": ("rejected",),
    "regenerate": ("rejected",),
    "approve": ("pending", "rejected"),
    "reject": (),
    "mark_sent": ("rejected",),
}


def email_status_of(email: Optional[Dict[str, Any]]) -> Optional[str]:
    return (email or {}).get("status")


def plan_email_transition(email: Optional[Dict[str, Any]], user_id: str, action: str) -> Dict[str, Any]:
    """Whether `action` may be applied to `email` by `user_id`. Pure. Returns
    {"ok": bool, "code": None | "email_not_found" | "forbidden" |
    "invalid_email_transition", "from_status": str|None, "to_status": str|None}."""
    current = email_status_of(email)

    def refuse(code: str) -> Dict[str, Any]:
        return {"ok": False, "code": code, "from_status": current, "to_status": None}

    if email is None:
        return refuse("email_not_found")
    if email.get("user_id") != user_id:
        return refuse("forbidden")
    allowed_from, to_status = EMAIL_TRANSITIONS.get(action, ((), None))
    if current not in allowed_from:
        return refuse("invalid_email_transition")
    return {"ok": True, "code": None, "from_status": current, "to_status": to_status}


def contact_blocks(action: str, contact_review_status: Optional[str]) -> bool:
    """True when the contact's review status forbids `action` on its email.
    A contact without review_status reads as not_required (RF15)."""
    return (contact_review_status or "not_required") in CONTACT_REVIEW_BLOCKS.get(action, ())


class EmailHistoryEntry(BaseModel):
    """One decision on an email. `from_status` is None for `generate`;
    previous_subject / previous_body are only set by `regenerate`."""

    action: EmailAction
    at: datetime
    by: str
    by_name: Optional[str] = None
    from_status: Optional[EmailStatus] = None
    to_status: EmailStatus
    previous_subject: Optional[str] = None
    previous_body: Optional[str] = None


class OutreachEmail(BaseModel):
    id: str
    user_id: str
    lead_id: str
    contact_id: str
    # Snapshot of the vacancy and the contact when the email was written.
    job_title: str = ""
    company_name: str = ""
    contact_name: str = ""
    contact_job_title: str = ""
    to_email: Optional[str] = None
    contact_review_status: Optional[str] = None
    # Plain text: shown as text, never interpreted as HTML.
    subject: str
    body: str
    status: EmailStatus = EmailStatus.PENDING_REVIEW
    approved_by: Optional[str] = None
    approved_by_name: Optional[str] = None
    approved_at: Optional[datetime] = None
    rejected_by: Optional[str] = None
    rejected_by_name: Optional[str] = None
    rejected_at: Optional[datetime] = None
    sent_marked_by: Optional[str] = None
    sent_marked_by_name: Optional[str] = None
    sent_at: Optional[datetime] = None
    last_decision_by: Optional[str] = None
    last_decision_at: Optional[datetime] = None
    history: List[EmailHistoryEntry] = Field(default_factory=list)
    model: Optional[str] = None
    prompt_version: Optional[str] = None
    # Firestore stores createdAt/updatedAt (FirestoreRepo.create). Accept both
    # spellings on input only: the JSON key stays created_at/updated_at.
    created_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("created_at", "createdAt"))
    updated_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("updated_at", "updatedAt"))


class OutreachEmailCreate(BaseModel):
    """POST /outreach-emails: write an email for one contact of one lead.
    user_id comes from the session; anything else in the body is ignored."""

    model_config = ConfigDict(extra="ignore")

    lead_id: str = Field(..., min_length=1)
    contact_id: str = Field(..., min_length=1)


class OutreachEmailResponse(OutreachEmail):
    """The email after an action, plus the lead's status afterwards and
    warning codes (e.g. "contact_pending_review"). Additive over OutreachEmail."""

    warnings: List[str] = Field(default_factory=list)
    lead_status: Optional[LeadStatus] = None


class OutreachEmailListResponse(BaseModel):
    items: List[OutreachEmail]
    total: int
