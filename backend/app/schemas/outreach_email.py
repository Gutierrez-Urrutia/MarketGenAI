"""Schemas for prospecting emails (Agente 3, RF-VTA-16).

Named `outreach_email` (not `outreach`) and backed by its own Firestore
collection `outreach_emails` — distinct from the `outreach` collection used by
routers/outreach.py (AI response review queue), which serves a different
workflow and is not touched by this one.

An email is written for one contact of one lead and goes through review:

    pending_review → approved → sent
    pending_review | approved → rejected

An approved email reaches `sent` in one of two ways: `send` delivers it by
SMTP with the user's account (routers/outreach_emails.py, POST /{id}/send, only
with the real-send switches on), or `mark_sent` records that the user sent it
by other means (`send_method` tells them apart). `sent` and `rejected` are
final; a rejected email no longer counts as active, so a new one may be written
for the same contact. Every decision is appended to the email's `history`, and
a regeneration keeps the previous subject and body there.

While an SMTP send runs, the email stays `approved` and carries a `send_lock`
(see plan_send_lock). A send whose outcome is unknown (timeout after DATA)
leaves the lock `uncertain`: it blocks a plain retry until the user forces one,
marks the email as sent, or rejects it.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, computed_field

from app.core.pipeline_constants import OUTREACH_EMAIL_LANGUAGE, OUTREACH_UNSUBSCRIBE_LINE
from app.schemas.lead import LeadStatus


class EmailStatus(str, Enum):
    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    SENT = "sent"
    REJECTED = "rejected"


EmailAction = Literal["generate", "regenerate", "approve", "reject", "mark_sent", "send"]
SendMethod = Literal["smtp", "manual"]

# Statuses that make an email the contact's active one (at most one per contact).
ACTIVE_EMAIL_STATUSES = (EmailStatus.PENDING_REVIEW.value, EmailStatus.APPROVED.value)

# action → (statuses it may be applied to, status afterwards). `generate`
# creates the email, so it has no "from" status.
EMAIL_TRANSITIONS: Dict[str, tuple] = {
    "regenerate": ((EmailStatus.PENDING_REVIEW.value,), EmailStatus.PENDING_REVIEW.value),
    "approve": ((EmailStatus.PENDING_REVIEW.value,), EmailStatus.APPROVED.value),
    "reject": ((EmailStatus.PENDING_REVIEW.value, EmailStatus.APPROVED.value), EmailStatus.REJECTED.value),
    "mark_sent": ((EmailStatus.APPROVED.value,), EmailStatus.SENT.value),
    "send": ((EmailStatus.APPROVED.value,), EmailStatus.SENT.value),
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
    # Stricter than mark_sent: the system itself sends, so the contact must
    # have been reviewed (or never needed it).
    "send": ("pending", "rejected"),
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


def send_lock_state(email: Optional[Dict[str, Any]], now: datetime, stale_after: timedelta) -> str:
    """State of the email's send lock: "free" (none), "uncertain" (a send
    whose outcome is unknown), "held" (a send running now) or "stale" (older
    than `stale_after`: the process presumably died). Pure."""
    lock = (email or {}).get("send_lock")
    if not lock:
        return "free"
    if lock.get("uncertain"):
        return "uncertain"
    at = lock.get("at")
    if isinstance(at, datetime):
        at = at if at.tzinfo else at.replace(tzinfo=now.tzinfo)
        if now - at < stale_after:
            return "held"
    return "stale"


def plan_send_lock(
    email: Optional[Dict[str, Any]], now: datetime, action: str, stale_after: timedelta, force_retry: bool = False,
) -> Dict[str, Any]:
    """Whether the send lock lets `action` go ahead. Pure. Returns {"ok",
    "code": None | "send_in_progress" | "send_uncertain", "state",
    "clear_lock": bool}.

    - A held lock (a send running now) blocks everything: a second send,
      mark_sent and reject alike, so two tabs never send and mark at once.
    - An uncertain lock blocks a plain send (409 send_uncertain); a send with
      `force_retry` takes it over. mark_sent and reject resolve it and clear it.
    - A stale lock is replaced by a send and cleared by mark_sent / reject.
    """
    state = send_lock_state(email, now, stale_after)

    def result(ok: bool, code: Optional[str] = None, clear: bool = False) -> Dict[str, Any]:
        return {"ok": ok, "code": code, "state": state, "clear_lock": clear}

    if state == "held":
        return result(False, "send_in_progress")
    if action == "send":
        if state == "uncertain" and not force_retry:
            return result(False, "send_uncertain")
        return result(True)
    return result(True, clear=state in ("uncertain", "stale"))


def unsubscribe_line_for(language: Optional[str]) -> str:
    """The opt-out line appended to a sent email, in its language (English
    for emails saved without one)."""
    return OUTREACH_UNSUBSCRIBE_LINE.get(
        language or OUTREACH_EMAIL_LANGUAGE, OUTREACH_UNSUBSCRIBE_LINE[OUTREACH_EMAIL_LANGUAGE],
    )


def contact_blocks(action: str, contact_review_status: Optional[str]) -> bool:
    """True when the contact's review status forbids `action` on its email.
    A contact without review_status reads as not_required (RF15)."""
    return (contact_review_status or "not_required") in CONTACT_REVIEW_BLOCKS.get(action, ())


class EmailHistoryEntry(BaseModel):
    """One decision on an email. `from_status` is None for `generate`;
    previous_subject / previous_body / previous_language are only set by
    `regenerate`."""

    action: EmailAction
    at: datetime
    by: str
    by_name: Optional[str] = None
    from_status: Optional[EmailStatus] = None
    to_status: EmailStatus
    previous_subject: Optional[str] = None
    previous_body: Optional[str] = None
    previous_language: Optional[str] = None
    # Set by `send` (smtp) and `mark_sent` (manual).
    send_method: Optional[SendMethod] = None
    smtp_message_id: Optional[str] = None
    # mark_sent / reject after a failed or uncertain SMTP send: that error's code.
    send_error: Optional[str] = None


class SendLock(BaseModel):
    """A send in progress (or of unknown outcome, when `uncertain`)."""

    id: str
    at: datetime
    uncertain: bool = False


class SendError(BaseModel):
    """The last failed SMTP send: a code only, never the server's text."""

    code: str
    at: datetime


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
    # Who sent it by SMTP (`send`); sent_marked_by* is who marked it (`mark_sent`).
    sent_by: Optional[str] = None
    sent_by_name: Optional[str] = None
    sent_at: Optional[datetime] = None
    # "smtp" | "manual"; None on emails marked before real sending existed (manual).
    send_method: Optional[SendMethod] = None
    # Generated and stored before the SMTP conversation starts; a retry reuses it.
    smtp_message_id: Optional[str] = None
    send_lock: Optional[SendLock] = None
    last_send_error: Optional[SendError] = None
    send_attempts: int = 0
    last_decision_by: Optional[str] = None
    last_decision_at: Optional[datetime] = None
    history: List[EmailHistoryEntry] = Field(default_factory=list)
    model: Optional[str] = None
    prompt_version: Optional[str] = None
    # Language of subject and body (en / es / pt); None on emails saved before it.
    language: Optional[str] = None
    # Firestore stores createdAt/updatedAt (FirestoreRepo.create). Accept both
    # spellings on input only: the JSON key stays created_at/updated_at.
    created_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("created_at", "createdAt"))
    updated_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("updated_at", "updatedAt"))

    @computed_field
    @property
    def unsubscribe_line(self) -> str:
        """The opt-out line the server appends when it sends this email (in
        its language): shown to the reviewer, never stored with the body."""
        return unsubscribe_line_for(self.language)


class OutreachEmailCreate(BaseModel):
    """POST /outreach-emails: write an email for one contact of one lead.
    user_id comes from the session; anything else in the body is ignored."""

    model_config = ConfigDict(extra="ignore")

    lead_id: str = Field(..., min_length=1)
    contact_id: str = Field(..., min_length=1)
    # en / es / pt; checked by the service (422 invalid_language). None → "en".
    language: Optional[str] = None


class OutreachEmailRegenerate(BaseModel):
    """PATCH /outreach-emails/{id}/regenerate (optional body). Without
    `language` the email keeps its current one."""

    model_config = ConfigDict(extra="ignore")

    language: Optional[str] = None


class OutreachEmailSend(BaseModel):
    """POST /outreach-emails/{id}/send. `confirm_to_email` is the recipient
    the user confirmed (must match the email's); `force_retry` only acts on a
    send of unknown outcome (uncertain lock) and is ignored otherwise."""

    model_config = ConfigDict(extra="ignore")

    confirm_to_email: str = Field(..., min_length=1, max_length=320)
    force_retry: bool = False


class OutreachEmailResponse(OutreachEmail):
    """The email after an action, plus the lead's status afterwards and
    warning codes (e.g. "contact_pending_review"). Additive over OutreachEmail."""

    warnings: List[str] = Field(default_factory=list)
    lead_status: Optional[LeadStatus] = None


class OutreachEmailListResponse(BaseModel):
    items: List[OutreachEmail]
    total: int


class SendStatusResponse(BaseModel):
    """GET /outreach-emails/send-status: whether «Enviar» can be used, with
    no secret in it. `real_send_enabled` is server_send_enabled and
    user_send_enabled together."""

    smtp_configured: bool
    smtp_missing_fields: List[str]
    server_send_enabled: bool
    user_send_enabled: bool
    real_send_enabled: bool
    daily_limit: int
    sent_today: int
    # Shown in the send confirmation (not secret: also in /pipeline/config).
    sender_email: str = ""
    sender_name: str = ""


class DoNotContactCreate(BaseModel):
    """POST /outreach-emails/do-not-contact: exactly one of `email_id` (the
    recipient of that email, read by the server), `email` or `domain`."""

    model_config = ConfigDict(extra="ignore")

    email_id: Optional[str] = Field(None, min_length=1)
    email: Optional[str] = Field(None, min_length=1, max_length=320)
    domain: Optional[str] = Field(None, min_length=1, max_length=253)
    reason: Optional[str] = Field(None, max_length=200)


class DoNotContactEntry(BaseModel):
    id: str
    kind: Literal["email", "domain"]
    value: str
    reason: Optional[str] = None
    source_email_id: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = Field(None, validation_alias=AliasChoices("created_at", "createdAt"))


class DoNotContactListResponse(BaseModel):
    items: List[DoNotContactEntry]
    total: int
