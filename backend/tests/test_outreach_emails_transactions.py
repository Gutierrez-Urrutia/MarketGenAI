"""RF-VTA-16: the transactional methods of LeadsRepo / OutreachEmailsRepo over
an in-memory Firestore (tests/fake_firestore.py). Synthetic data only."""
from datetime import datetime, timedelta, timezone

import pytest

from app.core.pipeline_constants import COMPOSING_STALE_SECONDS
from app.services.firestore_service import LeadsRepo, OutreachEmailsRepo
from tests.fake_firestore import use_fake_firestore

USER = "user-1"
NOW = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def db():
    with use_fake_firestore() as fake:
        yield fake


@pytest.fixture
def leads():
    return LeadsRepo()


@pytest.fixture
def emails():
    return OutreachEmailsRepo()


def put_lead(db, status="contacts_found", **extra):
    db.put("leads", "lead-1", {"user_id": USER, "status": status, **extra})


def put_email(db, doc_id="e-1", status="pending_review", **extra):
    db.put("outreach_emails", doc_id, {
        "user_id": USER, "lead_id": "lead-1", "contact_id": "c-1", "status": status,
        "subject": "Asunto", "body": "Cuerpo", "history": [], **extra,
    })


# ── start_composing ──────────────────────────────────────────────────────────
async def test_start_composing_marks_the_lead_and_keeps_the_previous_status(db, leads):
    put_lead(db, "ready_for_review")
    plan = await leads.start_composing("lead-1", USER, "comp-1", NOW)
    assert plan["started"] is True
    lead = db.doc("leads", "lead-1")
    assert lead["status"] == "composing" and lead["composing_id"] == "comp-1"
    assert lead["composing_started_at"] == NOW and lead["composing_previous_status"] == "ready_for_review"


async def test_start_composing_refused_while_live_writes_nothing(db, leads):
    put_lead(db, "composing", composing_id="comp-live", composing_previous_status="contacts_found",
             composing_started_at=NOW - timedelta(seconds=10))
    plan = await leads.start_composing("lead-1", USER, "comp-2", NOW)
    assert plan["code"] == "compose_in_progress"
    assert db.writes_to("leads") == []
    assert db.doc("leads", "lead-1")["composing_id"] == "comp-live"


async def test_start_composing_takes_over_a_stuck_generation(db, leads):
    put_lead(db, "composing", composing_id="comp-old", composing_previous_status="approved",
             composing_started_at=NOW - timedelta(seconds=COMPOSING_STALE_SECONDS + 5))
    plan = await leads.start_composing("lead-1", USER, "comp-new", NOW)
    assert plan["started"] is True and plan["stale_compose_id"] == "comp-old"
    lead = db.doc("leads", "lead-1")
    assert lead["composing_id"] == "comp-new" and lead["composing_previous_status"] == "approved"


async def test_start_composing_on_a_foreign_lead_writes_nothing(db, leads):
    db.put("leads", "lead-1", {"user_id": "otro", "status": "contacts_found"})
    assert (await leads.start_composing("lead-1", USER, "comp-1", NOW))["code"] == "forbidden"
    assert db.writes == []


# ── finish_composing / restore_after_compose ─────────────────────────────────
async def test_finish_composing_writes_the_summary_and_clears_the_composing_fields(db, leads):
    put_lead(db, "contacts_found")
    await leads.start_composing("lead-1", USER, "comp-1", NOW)
    status = await leads.finish_composing("lead-1", "comp-1", ["pending_review"], True, NOW)
    assert status == "ready_for_review"
    lead = db.doc("leads", "lead-1")
    assert lead["status"] == "ready_for_review"
    for field in ("composing_id", "composing_started_at", "composing_previous_status"):
        assert field not in lead


async def test_finish_composing_of_a_generation_taken_over_writes_nothing(db, leads):
    put_lead(db, "composing", composing_id="comp-new", composing_started_at=NOW,
             composing_previous_status="contacts_found")
    status = await leads.finish_composing("lead-1", "comp-old", ["pending_review"], True, NOW)
    assert status == "composing"
    assert db.writes == [] and db.doc("leads", "lead-1")["composing_id"] == "comp-new"


async def test_restore_after_compose_puts_back_the_previous_status(db, leads):
    put_lead(db, "approved")
    await leads.start_composing("lead-1", USER, "comp-1", NOW)
    status = await leads.restore_after_compose("lead-1", "comp-1", NOW)
    assert status == "approved"
    lead = db.doc("leads", "lead-1")
    assert lead["status"] == "approved" and "composing_started_at" not in lead and "composing_id" not in lead


async def test_restore_after_compose_of_another_generation_writes_nothing(db, leads):
    put_lead(db, "composing", composing_id="comp-new", composing_started_at=NOW,
             composing_previous_status="contacts_found")
    assert await leads.restore_after_compose("lead-1", "comp-old", NOW) == "composing"
    assert db.writes == []


# ── recompute_status_from_emails ─────────────────────────────────────────────
async def test_recompute_writes_the_summarized_status(db, leads):
    put_lead(db, "ready_for_review")
    assert await leads.recompute_status_from_emails("lead-1", USER, ["approved"], True, NOW) == "approved"
    assert db.doc("leads", "lead-1")["status"] == "approved"


async def test_recompute_after_the_last_rejection_returns_to_contacts_found(db, leads):
    put_lead(db, "ready_for_review")
    assert await leads.recompute_status_from_emails("lead-1", USER, ["rejected"], True, NOW) == "contacts_found"


async def test_recompute_never_overwrites_a_running_generation(db, leads):
    put_lead(db, "composing", composing_id="comp-1", composing_started_at=NOW)
    assert await leads.recompute_status_from_emails("lead-1", USER, ["approved"], True, NOW) == "composing"
    assert db.writes == []


async def test_recompute_of_a_missing_lead_returns_none(db, leads):
    assert await leads.recompute_status_from_emails("nope", USER, ["approved"], True, NOW) is None
    assert db.writes == []


# ── transition ───────────────────────────────────────────────────────────────
async def test_transition_writes_fields_and_appends_history(db, emails):
    put_email(db)
    result = await emails.transition("e-1", USER, "Ana", "approve", NOW, expected_from="pending_review")
    assert result["ok"] is True and result["email"]["status"] == "approved"
    stored = db.doc("outreach_emails", "e-1")
    assert stored["status"] == "approved" and stored["approved_by"] == USER and stored["approved_at"] == NOW
    assert stored["history"] == [{
        "action": "approve", "at": NOW, "by": USER, "by_name": "Ana",
        "from_status": "pending_review", "to_status": "approved",
    }]


async def test_transition_refused_when_the_expected_status_changed_meanwhile(db, emails):
    # The caller read pending_review; another request rejected it before the write.
    put_email(db, status="rejected")
    result = await emails.transition("e-1", USER, "Ana", "approve", NOW, expected_from="pending_review")
    assert result["ok"] is False and result["code"] == "invalid_email_transition"
    assert result["from_status"] == "rejected"
    assert db.writes == []
    assert db.doc("outreach_emails", "e-1")["status"] == "rejected"


async def test_transition_refused_when_another_allowed_status_was_reached(db, emails):
    # reject is allowed from approved, but the caller expected pending_review.
    put_email(db, status="approved")
    result = await emails.transition("e-1", USER, "Ana", "reject", NOW, expected_from="pending_review")
    assert result["code"] == "invalid_email_transition"
    assert db.writes == []


async def test_transition_rereads_the_email_inside_the_transaction(db, emails):
    put_email(db)
    await emails.transition("e-1", USER, "Ana", "approve", NOW)
    assert db.transactions[-1].reads == 1


async def test_transition_of_a_foreign_or_missing_email_writes_nothing(db, emails):
    put_email(db, user_id="otro")
    assert (await emails.transition("e-1", USER, "Ana", "approve", NOW))["code"] == "forbidden"
    assert (await emails.transition("nope", USER, "Ana", "approve", NOW))["code"] == "email_not_found"
    assert db.writes == []


async def test_two_history_entries_accumulate(db, emails):
    put_email(db)
    await emails.transition("e-1", USER, "Ana", "approve", NOW, expected_from="pending_review")
    later = NOW + timedelta(minutes=1)
    await emails.transition("e-1", USER, "Ana", "mark_sent", later, expected_from="approved")
    stored = db.doc("outreach_emails", "e-1")
    assert [h["action"] for h in stored["history"]] == ["approve", "mark_sent"]
    assert stored["status"] == "sent" and stored["sent_at"] == later


# ── Queries: equality only ───────────────────────────────────────────────────
async def test_queries_use_equality_filters_only_and_sort_in_memory(db, emails):
    put_email(db, "e-1", createdAt=NOW)
    put_email(db, "e-2", createdAt=NOW + timedelta(minutes=1))
    db.put("outreach_emails", "e-3", {"user_id": "otro", "lead_id": "lead-1", "status": "pending_review",
                                      "createdAt": NOW})
    items = await emails.list_by_user(USER, lead_id="lead-1")
    assert [e["id"] for e in items] == ["e-2", "e-1"]
    collection, filters, order = db.queries[-1]
    assert collection == "outreach_emails" and order is None
    assert filters == [("user_id", "==", USER), ("lead_id", "==", "lead-1")]


async def test_find_active_for_contact_ignores_rejected_and_sent(db, emails):
    put_email(db, "e-1", status="rejected", createdAt=NOW)
    put_email(db, "e-2", status="sent", createdAt=NOW)
    assert await emails.find_active_for_contact("lead-1", "c-1", USER) is None
    put_email(db, "e-3", status="approved", createdAt=NOW)
    assert (await emails.find_active_for_contact("lead-1", "c-1", USER))["id"] == "e-3"
