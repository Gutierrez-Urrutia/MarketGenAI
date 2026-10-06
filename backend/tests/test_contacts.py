"""Tests for lead contacts (Fase 3 — Agente 2 output): schemas and repo helpers."""
from __future__ import annotations

from datetime import datetime, timezone

from app.schemas.contact import Contact
from tests.conftest import FAKE_USER_SUB


def fake_contact(overrides: dict | None = None) -> dict:
    base = {
        "id": "contact-001",
        "lead_id": "lead-001",
        "user_id": FAKE_USER_SUB,
        "full_name": "Ana García",
        "email": "ana@acme.com",
        "linkedin_url": None,
        "job_title": "Head of Operations",
        "role": "department_head",
        "company": "Acme Corp",
        "confidence_score": 0.8,
        "source": "fake",
        "verified": False,
    }
    if overrides:
        base.update(overrides)
    return base


CREATED = datetime(2026, 10, 5, 22, 30, 12, 123456, tzinfo=timezone.utc)
UPDATED = datetime(2026, 10, 6, 9, 1, 2, 654321, tzinfo=timezone.utc)


def firestore_contact() -> dict:
    """A contact as stored in Firestore: FirestoreRepo.create writes camelCase
    createdAt/updatedAt, not created_at/updated_at."""
    return {**fake_contact(), "createdAt": CREATED, "updatedAt": UPDATED}


def test_contact_schema_reads_firestore_camel_case_timestamps():
    contact = Contact.model_validate(firestore_contact())
    assert contact.created_at == CREATED
    assert contact.updated_at == UPDATED


def test_contact_schema_still_accepts_snake_case_timestamps():
    contact = Contact.model_validate(fake_contact({"created_at": CREATED, "updated_at": UPDATED}))
    assert contact.created_at == CREATED
    assert contact.updated_at == UPDATED


def test_contact_schema_timestamps_default_to_none():
    contact = Contact.model_validate(fake_contact())
    assert contact.created_at is None
    assert contact.updated_at is None


def test_contact_json_keeps_snake_case_timestamp_keys():
    dumped = Contact.model_validate(firestore_contact()).model_dump(mode="json")
    assert "created_at" in dumped and "updated_at" in dumped
    assert "createdAt" not in dumped and "updatedAt" not in dumped
    assert dumped["created_at"] == CREATED.isoformat().replace("+00:00", "Z")
