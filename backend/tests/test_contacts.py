"""Tests for lead contacts (Fase 3 — Agente 2 output): schemas and repo helpers."""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

from app.schemas.contact import Contact, ContactCreate
from app.services.firestore_service import ContactsRepo, contacts_repo
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


# ── ContactCreate ─────────────────────────────────────────────────────────────
def create_payload(overrides: dict | None = None) -> dict:
    base = {
        "full_name": "Ana García",
        "job_title": "Head of Operations",
        "company": "Acme Corp",
        "email": "ana@acme.com",
        "linkedin_url": "https://www.linkedin.com/in/ana",
        "role": "department_head",
        "confidence_score": 0.8,
        "source": "fake",
    }
    if overrides:
        base.update(overrides)
    return base


def test_contact_create_defaults():
    minimal = ContactCreate(full_name="Ana", company="Acme", source="fake")
    assert minimal.job_title == ""
    assert minimal.email is None
    assert minimal.linkedin_url is None
    assert minimal.role.value == "unknown"
    assert minimal.confidence_score == 0.0
    assert minimal.verified is False
    assert minimal.email_type is None
    assert minimal.email_verification_status is None
    assert minimal.email_verified_at is None
    assert minimal.seniority is None
    assert minimal.department is None
    assert minimal.source_urls == []
    assert minimal.source_last_seen_at is None


# ── Provider-reported email fields (RF15) ─────────────────────────────────────
def test_contact_create_provider_fields_round_trip():
    contact = ContactCreate.model_validate(create_payload({
        "email_type": "personal", "email_verification_status": " valid ",
        "email_verified_at": "2026-02-20T00:00:00+00:00", "seniority": "executive", "department": " ",
        "source_urls": ["https://example.com/team", "javascript:alert(1)", " https://example.org/x ", "http://[abc"],
        "source_last_seen_at": "2026-03-02T00:00:00+00:00",
    }))
    assert contact.email_type == "personal"
    assert contact.email_verification_status == "valid"
    assert contact.email_verified_at == datetime(2026, 2, 20, tzinfo=timezone.utc)
    assert contact.seniority == "executive"
    assert contact.department is None
    assert contact.source_urls == ["https://example.com/team", "https://example.org/x"]
    assert contact.source_last_seen_at == datetime(2026, 3, 2, tzinfo=timezone.utc)


def test_contact_create_rejects_unknown_email_type():
    with pytest.raises(ValidationError):
        ContactCreate.model_validate(create_payload({"email_type": "role"}))


def test_contact_saved_before_rf15_reads_without_the_provider_fields():
    contact = Contact.model_validate(fake_contact())
    assert contact.email_type is None
    assert contact.email_verified_at is None
    assert contact.source_urls == []


async def test_create_for_lead_saves_the_provider_fields(saved_docs):
    contact = ContactCreate.model_validate(create_payload({
        "email_type": "personal", "email_verification_status": "accept_all",
        "email_verified_at": "2026-02-20T00:00:00+00:00", "source_urls": ["https://example.com/team"],
    }))
    doc = await contacts_repo.create_for_lead("lead-001", FAKE_USER_SUB, contact)
    assert doc["email_type"] == "personal"
    assert doc["email_verification_status"] == "accept_all"
    assert doc["email_verified_at"] == "2026-02-20T00:00:00Z"
    assert doc["source_urls"] == ["https://example.com/team"]
    read_back = Contact.model_validate(doc)
    assert read_back.email_verified_at == datetime(2026, 2, 20, tzinfo=timezone.utc)


def test_contact_create_strips_text_fields():
    contact = ContactCreate.model_validate(create_payload({
        "full_name": "  Ana García ", "company": " Acme Corp ", "job_title": " CTO ", "source": " fake ",
        "email": "  ana@acme.com  ",
    }))
    assert contact.full_name == "Ana García"
    assert contact.company == "Acme Corp"
    assert contact.job_title == "CTO"
    assert contact.source == "fake"
    assert contact.email == "ana@acme.com"


@pytest.mark.parametrize("field", ["full_name", "company", "source"])
@pytest.mark.parametrize("value", ["", "   "])
def test_contact_create_rejects_blank_required_fields(field, value):
    with pytest.raises(ValidationError):
        ContactCreate.model_validate(create_payload({field: value}))


@pytest.mark.parametrize("value", ["", "   "])
def test_contact_create_blank_email_becomes_none(value):
    assert ContactCreate.model_validate(create_payload({"email": value})).email is None


@pytest.mark.parametrize("url", [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com/ana",
    "www.linkedin.com/in/ana",
    "",
])
def test_contact_create_drops_non_http_linkedin_url(url):
    assert ContactCreate.model_validate(create_payload({"linkedin_url": url})).linkedin_url is None


@pytest.mark.parametrize("url", ["http://[abc", "https://[::1"])
def test_contact_create_malformed_linkedin_url_drops_only_the_url(url):
    contact = ContactCreate.model_validate(create_payload({"linkedin_url": url}))
    assert contact.linkedin_url is None
    # The rest of the contact survives.
    assert contact.full_name == "Ana García"
    assert contact.company == "Acme Corp"
    assert contact.email == "ana@acme.com"
    assert contact.job_title == "Head of Operations"
    assert contact.role.value == "department_head"
    assert contact.confidence_score == 0.8
    assert contact.source == "fake"


@pytest.mark.parametrize("url", ["https://www.linkedin.com/in/ana", "http://linkedin.com/in/ana"])
def test_contact_create_keeps_http_linkedin_url(url):
    assert ContactCreate.model_validate(create_payload({"linkedin_url": f" {url} "})).linkedin_url == url


@pytest.mark.parametrize("score", [-0.1, 1.1])
def test_contact_create_rejects_out_of_range_confidence(score):
    with pytest.raises(ValidationError):
        ContactCreate.model_validate(create_payload({"confidence_score": score}))


def test_contact_create_rejects_unknown_role():
    with pytest.raises(ValidationError):
        ContactCreate.model_validate(create_payload({"role": "ceo"}))


def test_contact_create_ignores_user_id_and_lead_id_in_body():
    contact = ContactCreate.model_validate(create_payload({"user_id": "attacker", "lead_id": "other-lead"}))
    dumped = contact.model_dump()
    assert "user_id" not in dumped
    assert "lead_id" not in dumped
    assert not hasattr(contact, "user_id")
    assert not hasattr(contact, "lead_id")


# ── ContactsRepo ──────────────────────────────────────────────────────────────
@pytest.fixture
def saved_docs():
    """Capture what ContactsRepo.create writes, through the real create() path,
    with the Firestore document reference replaced (no Firestore access)."""
    written = {}

    def fake_doc(doc_id):
        ref = MagicMock()

        async def _set(payload):
            written[doc_id] = payload

        ref.set = AsyncMock(side_effect=_set)
        return ref

    with patch.object(ContactsRepo, "_doc", side_effect=fake_doc):
        yield written


async def test_create_for_lead_saves_both_ids_and_contact_fields(saved_docs):
    contact = ContactCreate.model_validate(create_payload())
    result = await contacts_repo.create_for_lead("lead-001", FAKE_USER_SUB, contact)

    assert len(saved_docs) == 1
    doc_id, doc = next(iter(saved_docs.items()))
    assert result == doc
    assert doc["id"] == doc_id
    assert doc["lead_id"] == "lead-001"
    assert doc["user_id"] == FAKE_USER_SUB
    assert doc["full_name"] == "Ana García"
    assert doc["email"] == "ana@acme.com"
    assert doc["role"] == "department_head"  # stored as a plain string, not the enum
    assert doc["confidence_score"] == 0.8
    assert doc["verified"] is False
    assert "createdAt" in doc and "updatedAt" in doc


async def test_create_for_lead_ids_in_body_cannot_override_parameters(saved_docs):
    contact = ContactCreate.model_validate(create_payload({"user_id": "attacker", "lead_id": "other-lead"}))
    await contacts_repo.create_for_lead("lead-001", FAKE_USER_SUB, contact)

    doc = next(iter(saved_docs.values()))
    assert doc["lead_id"] == "lead-001"
    assert doc["user_id"] == FAKE_USER_SUB
    assert "attacker" not in doc.values()
    assert "other-lead" not in doc.values()


async def test_create_for_lead_round_trips_through_contact_schema(saved_docs):
    contact = ContactCreate.model_validate(create_payload())
    doc = await contacts_repo.create_for_lead("lead-001", FAKE_USER_SUB, contact)

    read_back = Contact.model_validate(doc)
    assert read_back.lead_id == "lead-001"
    assert read_back.user_id == FAKE_USER_SUB
    assert read_back.created_at is not None and read_back.updated_at is not None


async def test_list_by_lead_filters_by_user_and_lead():
    rows = [fake_contact({"id": "c1"}), fake_contact({"id": "c2"})]
    with patch.object(ContactsRepo, "list", new_callable=AsyncMock, return_value=rows) as mock_list:
        result = await contacts_repo.list_by_lead("lead-001", FAKE_USER_SUB)

    assert result == rows
    mock_list.assert_awaited_once_with(
        filters=[("user_id", "==", FAKE_USER_SUB), ("lead_id", "==", "lead-001")],
        order_by="confidence_score",
        order_direction="DESCENDING",
        limit=100,
    )


async def test_list_by_lead_passes_limit():
    with patch.object(ContactsRepo, "list", new_callable=AsyncMock, return_value=[]) as mock_list:
        await contacts_repo.list_by_lead("lead-001", FAKE_USER_SUB, limit=5)
    assert mock_list.await_args.kwargs["limit"] == 5


# ── Role executive, provider confidence and verification source (RF15) ───────
def test_contact_accepts_the_executive_role():
    contact = ContactCreate.model_validate(create_payload({"role": "executive"}))
    assert contact.role.value == "executive"
    assert Contact.model_validate(fake_contact({"role": "executive"})).role.value == "executive"


def test_contact_saved_before_rf15_reads_without_provider_confidence_nor_verification_source():
    contact = Contact.model_validate(fake_contact())
    assert contact.provider_confidence_score is None
    assert contact.email_verification_source is None


def test_contact_create_provider_confidence_and_verification_source():
    contact = ContactCreate.model_validate(create_payload({
        "provider_confidence_score": 0.94, "email_verification_source": " hunter_email_verifier ",
    }))
    assert contact.provider_confidence_score == 0.94
    assert contact.email_verification_source == "hunter_email_verifier"
    assert ContactCreate.model_validate(create_payload({"email_verification_source": "  "})).email_verification_source is None


@pytest.mark.parametrize("score", [-0.1, 1.1])
def test_contact_create_rejects_out_of_range_provider_confidence(score):
    with pytest.raises(ValidationError):
        ContactCreate.model_validate(create_payload({"provider_confidence_score": score}))


async def test_create_for_lead_saves_role_executive_and_the_new_fields(saved_docs):
    contact = ContactCreate.model_validate(create_payload({
        "role": "executive", "confidence_score": 0.7, "provider_confidence_score": 0.94,
        "email_verification_source": "hunter_domain_search",
    }))
    doc = await contacts_repo.create_for_lead("lead-001", FAKE_USER_SUB, contact)
    assert doc["role"] == "executive"
    assert doc["confidence_score"] == 0.7
    assert doc["provider_confidence_score"] == 0.94
    assert doc["email_verification_source"] == "hunter_domain_search"
