"""RF-VTA-16, Fase 1: estados de los correos de prospección, resumen del
estado del lead y arranque de la redacción (funciones puras)."""
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.core.pipeline_constants import COMPOSING_STALE_SECONDS
from app.schemas.lead import LeadStatus
from app.schemas.outreach_email import (
    ACTIVE_EMAIL_STATUSES,
    EmailStatus,
    OutreachEmail,
    OutreachEmailCreate,
    contact_blocks,
    plan_email_transition,
)
from app.services.firestore_service import LeadsRepo, OutreachEmailsRepo

USER = "user-1"
NOW = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
ACTIONS = ("regenerate", "approve", "reject", "mark_sent")


def email(status, user_id=USER):
    return {"id": "e-1", "user_id": user_id, "status": status}


def lead(status="contacts_found", user_id=USER, **extra):
    return {"id": "lead-1", "user_id": user_id, "status": status, **extra}


# ── Estados del correo ────────────────────────────────────────────────────────
def test_email_statuses_are_exactly_the_four_of_the_review():
    assert {s.value for s in EmailStatus} == {"pending_review", "approved", "sent", "rejected"}
    assert ACTIVE_EMAIL_STATUSES == ("pending_review", "approved")


def test_auto_approved_no_longer_exists():
    with pytest.raises(ValueError):
        EmailStatus("auto_approved")
    with pytest.raises(ValueError):
        LeadStatus("auto_approved")
    assert "auto_approved" not in OutreachEmail.model_fields


@pytest.mark.parametrize("action, current, expected", [
    ("regenerate", "pending_review", "pending_review"),
    ("approve", "pending_review", "approved"),
    ("reject", "pending_review", "rejected"),
    ("reject", "approved", "rejected"),
    ("mark_sent", "approved", "sent"),
])
def test_allowed_transitions(action, current, expected):
    plan = plan_email_transition(email(current), USER, action)
    assert plan == {"ok": True, "code": None, "from_status": current, "to_status": expected}


@pytest.mark.parametrize("action, current", [
    ("mark_sent", "pending_review"),   # aprobar y marcar como enviado son pasos separados
    ("approve", "approved"),
    ("regenerate", "approved"),
])
def test_forbidden_transitions(action, current):
    plan = plan_email_transition(email(current), USER, action)
    assert plan["ok"] is False and plan["code"] == "invalid_email_transition"


@pytest.mark.parametrize("final", ["sent", "rejected"])
@pytest.mark.parametrize("action", ACTIONS)
def test_sent_and_rejected_are_final(final, action):
    plan = plan_email_transition(email(final), USER, action)
    assert plan["ok"] is False and plan["code"] == "invalid_email_transition"


def test_unknown_action_is_refused():
    assert plan_email_transition(email("pending_review"), USER, "reopen")["code"] == "invalid_email_transition"


def test_missing_and_foreign_emails_are_refused():
    assert plan_email_transition(None, USER, "approve")["code"] == "email_not_found"
    assert plan_email_transition(email("pending_review", "otro"), USER, "approve")["code"] == "forbidden"


@pytest.mark.parametrize("action, review, blocked", [
    ("generate", "pending", False),
    ("generate", "rejected", True),
    ("generate", None, False),
    ("approve", "pending", True),
    ("approve", "rejected", True),
    ("approve", "approved", False),
    ("approve", "not_required", False),
    ("approve", None, False),
    ("mark_sent", "rejected", True),
    ("mark_sent", "pending", False),
    ("reject", "rejected", False),
    ("regenerate", "rejected", True),
])
def test_contact_review_blocks(action, review, blocked):
    assert contact_blocks(action, review) is blocked


def test_create_body_ignores_user_id():
    body = OutreachEmailCreate(lead_id="lead-1", contact_id="c-1", user_id="otro")
    assert body.model_dump() == {"lead_id": "lead-1", "contact_id": "c-1", "language": None}
    assert OutreachEmailCreate(lead_id="lead-1", contact_id="c-1", language="pt").language == "pt"
    with pytest.raises(ValidationError):
        OutreachEmailCreate(lead_id="", contact_id="c-1")


# ── Resumen del estado del lead ───────────────────────────────────────────────
@pytest.mark.parametrize("statuses, has_contact, expected", [
    (["sent", "approved", "pending_review"], True, "sent"),
    (["approved", "pending_review", "rejected"], True, "approved"),
    (["pending_review", "rejected"], True, "ready_for_review"),
    (["rejected", "rejected"], True, "contacts_found"),
    (["rejected"], False, "new"),
    ([], True, "contacts_found"),
    ([], False, "new"),
])
def test_lead_status_from_emails_priority(statuses, has_contact, expected):
    assert LeadsRepo.lead_status_from_emails(statuses, has_contact) == expected


def test_plan_lead_status_leaves_missing_and_foreign_leads_alone():
    assert LeadsRepo.plan_lead_status_from_emails(None, USER, ["approved"], True) is None
    assert LeadsRepo.plan_lead_status_from_emails(lead(user_id="otro"), USER, ["approved"], True) is None


@pytest.mark.parametrize("current", ["researching", "composing", "rejected", "replied", "error"])
def test_plan_lead_status_never_touches_other_statuses(current):
    assert LeadsRepo.plan_lead_status_from_emails(lead(current), USER, ["sent"], True) is None


def test_plan_lead_status_returns_none_when_already_right():
    assert LeadsRepo.plan_lead_status_from_emails(lead("approved"), USER, ["approved"], True) is None


def test_rejecting_the_last_email_returns_the_lead_to_contacts_found_or_new():
    assert LeadsRepo.plan_lead_status_from_emails(lead("ready_for_review"), USER, ["rejected"], True) == "contacts_found"
    assert LeadsRepo.plan_lead_status_from_emails(lead("ready_for_review"), USER, ["rejected"], False) == "new"


# ── Arranque de la redacción (composing) ─────────────────────────────────────
@pytest.mark.parametrize("current", ["contacts_found", "ready_for_review", "approved", "sent"])
def test_compose_starts_from_a_lead_with_contacts(current):
    plan = LeadsRepo.plan_compose_start(lead(current), USER, NOW)
    assert plan == {"started": True, "code": None, "previous_status": current, "stale_compose_id": None}


@pytest.mark.parametrize("current", ["new", "researching", "rejected", "replied", "error"])
def test_compose_refused_from_other_statuses(current):
    assert LeadsRepo.plan_compose_start(lead(current), USER, NOW)["code"] == "lead_not_composable"


def test_compose_refused_for_missing_and_foreign_leads():
    assert LeadsRepo.plan_compose_start(None, USER, NOW)["code"] == "lead_not_found"
    assert LeadsRepo.plan_compose_start(lead(user_id="otro"), USER, NOW)["code"] == "forbidden"


def test_live_composing_blocks_a_new_generation():
    live = lead("composing", composing_id="c-live", composing_previous_status="approved",
                composing_started_at=NOW - timedelta(seconds=COMPOSING_STALE_SECONDS - 1))
    plan = LeadsRepo.plan_compose_start(live, USER, NOW)
    assert plan["started"] is False and plan["code"] == "compose_in_progress"


def test_stuck_composing_is_taken_over_after_120_seconds():
    stuck = lead("composing", composing_id="c-old", composing_previous_status="approved",
                 composing_started_at=NOW - timedelta(seconds=COMPOSING_STALE_SECONDS + 1))
    plan = LeadsRepo.plan_compose_start(stuck, USER, NOW)
    assert plan == {"started": True, "code": None, "previous_status": "approved", "stale_compose_id": "c-old"}


def test_composing_without_start_time_is_taken_over_and_falls_back_to_contacts_found():
    plan = LeadsRepo.plan_compose_start(lead("composing"), USER, NOW)
    assert plan["started"] is True and plan["previous_status"] == "contacts_found"


def test_compose_start_fields_and_owner_check():
    fields = LeadsRepo.compose_start_fields("c-1", NOW, "contacts_found")
    assert fields["status"] == "composing"
    assert fields["composing_id"] == "c-1" and fields["composing_started_at"] == NOW
    assert fields["composing_previous_status"] == "contacts_found"
    assert LeadsRepo.can_finish_composing({"status": "composing", "composing_id": "c-1"}, "c-1") is True
    assert LeadsRepo.can_finish_composing({"status": "composing", "composing_id": "c-2"}, "c-1") is False
    assert LeadsRepo.can_finish_composing({"status": "contacts_found", "composing_id": "c-1"}, "c-1") is False
    assert LeadsRepo.can_finish_composing(None, "c-1") is False


# ── Campos e historial de cada decisión ──────────────────────────────────────
def test_approve_records_who_and_when_and_appends_history():
    fields, entry = OutreachEmailsRepo.transition_fields("approve", "pending_review", "approved", USER, "Ana", NOW)
    assert fields == {
        "status": "approved", "last_decision_by": USER, "last_decision_at": NOW,
        "approved_by": USER, "approved_by_name": "Ana", "approved_at": NOW,
    }
    assert entry == {
        "action": "approve", "at": NOW, "by": USER, "by_name": "Ana",
        "from_status": "pending_review", "to_status": "approved",
    }


def test_mark_sent_writes_sent_at():
    fields, _ = OutreachEmailsRepo.transition_fields("mark_sent", "approved", "sent", USER, None, NOW)
    assert fields["sent_at"] == NOW and fields["sent_marked_by"] == USER and fields["status"] == "sent"


def test_regenerate_keeps_the_previous_version_in_history():
    fields, entry = OutreachEmailsRepo.transition_fields(
        "regenerate", "pending_review", "pending_review", USER, "Ana", NOW,
        extra={"subject": "Nuevo", "body": "Cuerpo nuevo"},
        history_extra={"previous_subject": "Viejo", "previous_body": "Cuerpo viejo"},
    )
    assert fields["subject"] == "Nuevo" and fields["body"] == "Cuerpo nuevo"
    assert "approved_by" not in fields
    assert entry["previous_subject"] == "Viejo" and entry["previous_body"] == "Cuerpo viejo"


# ── Envío real: candado de envío (funciones puras) ───────────────────────────
from app.schemas.outreach_email import plan_send_lock, send_lock_state  # noqa: E402

STALE = timedelta(seconds=40)


def locked(age_seconds=5, uncertain=False):
    return {"status": "approved", "send_lock": {"id": "l-1", "at": NOW - timedelta(seconds=age_seconds), "uncertain": uncertain}}


@pytest.mark.parametrize("doc, state", [
    ({"status": "approved"}, "free"),
    (locked(5), "held"),
    (locked(39), "held"),
    (locked(40), "stale"),
    (locked(5, uncertain=True), "uncertain"),
    (locked(5000, uncertain=True), "uncertain"),
    ({"send_lock": {"id": "l", "at": None}}, "stale"),
])
def test_send_lock_state(doc, state):
    assert send_lock_state(doc, NOW, STALE) == state


def test_a_naive_lock_time_reads_as_utc():
    doc = {"send_lock": {"id": "l", "at": (NOW - timedelta(seconds=5)).replace(tzinfo=None)}}
    assert send_lock_state(doc, NOW, STALE) == "held"


@pytest.mark.parametrize("doc, action, force, ok, code, clear", [
    ({}, "send", False, True, None, False),
    (locked(5), "send", False, False, "send_in_progress", False),
    (locked(5), "send", True, False, "send_in_progress", False),
    (locked(60), "send", False, True, None, False),
    (locked(5, True), "send", False, False, "send_uncertain", False),
    (locked(5, True), "send", True, True, None, False),
    (locked(5), "mark_sent", False, False, "send_in_progress", False),
    (locked(5), "reject", False, False, "send_in_progress", False),
    (locked(5, True), "mark_sent", False, True, None, True),
    (locked(5, True), "reject", False, True, None, True),
    (locked(60), "mark_sent", False, True, None, True),
    ({}, "mark_sent", False, True, None, False),
    ({}, "approve", False, True, None, False),
])
def test_plan_send_lock(doc, action, force, ok, code, clear):
    plan = plan_send_lock(doc, NOW, action, STALE, force_retry=force)
    assert (plan["ok"], plan["code"], plan["clear_lock"]) == (ok, code, clear)


def test_send_needs_a_reviewed_contact_and_an_approved_email():
    assert contact_blocks("send", "pending") and contact_blocks("send", "rejected")
    assert not contact_blocks("send", "approved") and not contact_blocks("send", None)
    assert plan_email_transition(email("approved"), USER, "send")["to_status"] == "sent"
    assert not plan_email_transition(email("pending_review"), USER, "send")["ok"]


def test_transition_fields_of_send_and_mark_sent():
    send_fields, _ = OutreachEmailsRepo.transition_fields("send", "approved", "sent", USER, "Ana", NOW)
    assert send_fields["send_method"] == "smtp" and send_fields["sent_by"] == USER and send_fields["sent_at"] == NOW
    mark_fields, _ = OutreachEmailsRepo.transition_fields("mark_sent", "approved", "sent", USER, "Ana", NOW)
    assert mark_fields["send_method"] == "manual" and mark_fields["sent_marked_by"] == USER
    assert "sent_by" not in mark_fields
