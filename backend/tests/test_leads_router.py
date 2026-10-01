"""Tests for /api/v1/leads (Fase 2 — read-only: list + detail)."""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.schemas.lead import Lead
from tests.conftest import FAKE_USER_SUB

API = "/api/v1/leads"


def fake_lead(overrides: dict | None = None) -> dict:
    base = {
        "id": "lead-001",
        "pipeline_config_id": "config-1",
        "user_id": FAKE_USER_SUB,
        "job_title": "Data Entry Specialist",
        "company_name": "Acme Corp",
        "job_description": "desc",
        "job_url": "https://acme.example.com/jobs/1",
        "source_id": "source-001",
        "location": None,
        "salary_range": None,
        "posted_date": None,
        "matched_keywords": ["BPO"],
        "relevance_score": 0.9,
        "status": "new",
        "pipeline_run_id": "run-1",
        "fingerprint": "fp-abc",
        "created_at": None,
        "updated_at": None,
    }
    if overrides:
        base.update(overrides)
    return base


CREATED = datetime(2026, 9, 25, 2, 33, 55, 838421, tzinfo=timezone.utc)
UPDATED = datetime(2026, 9, 29, 1, 15, 11, 833672, tzinfo=timezone.utc)


def firestore_lead() -> dict:
    """A lead as stored in Firestore: FirestoreRepo.create writes camelCase
    createdAt/updatedAt, not created_at/updated_at."""
    doc = fake_lead()
    del doc["created_at"], doc["updated_at"]
    return {**doc, "createdAt": CREATED, "updatedAt": UPDATED}


def test_lead_schema_reads_firestore_camel_case_timestamps():
    lead = Lead.model_validate(firestore_lead())
    assert lead.created_at == CREATED
    assert lead.updated_at == UPDATED


def test_lead_schema_still_accepts_snake_case_timestamps():
    lead = Lead.model_validate(fake_lead({"created_at": CREATED, "updated_at": UPDATED}))
    assert lead.created_at == CREATED
    assert lead.updated_at == UPDATED


@pytest.mark.asyncio
async def test_list_leads_returns_firestore_timestamps_as_snake_case(client):
    with patch(
        "app.routers.leads.leads_repo.list", new_callable=AsyncMock, return_value=[firestore_lead()],
    ):
        resp = await client.get(API)

    assert resp.status_code == 200
    item = resp.json()["items"][0]
    assert datetime.fromisoformat(item["created_at"].replace("Z", "+00:00")) == CREATED
    assert datetime.fromisoformat(item["updated_at"].replace("Z", "+00:00")) == UPDATED
    assert "createdAt" not in item and "updatedAt" not in item


@pytest.mark.asyncio
async def test_get_lead_returns_firestore_timestamps(client):
    with patch(
        "app.routers.leads.leads_repo.get_or_404", new_callable=AsyncMock, return_value=firestore_lead(),
    ):
        resp = await client.get(f"{API}/lead-001")
    assert resp.status_code == 200
    assert datetime.fromisoformat(resp.json()["created_at"].replace("Z", "+00:00")) == CREATED


@pytest.mark.asyncio
async def test_list_leads_scopes_by_user(client):
    with patch(
        "app.routers.leads.leads_repo.list", new_callable=AsyncMock, return_value=[fake_lead()],
    ) as mock_list:
        resp = await client.get(API)

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == "lead-001"
    filters = mock_list.call_args.kwargs["filters"]
    assert ("user_id", "==", FAKE_USER_SUB) in filters


@pytest.mark.asyncio
async def test_list_leads_filters_by_status_and_source(client):
    with patch(
        "app.routers.leads.leads_repo.list", new_callable=AsyncMock, return_value=[],
    ) as mock_list:
        resp = await client.get(API, params={"status": "new", "source_id": "source-001"})

    assert resp.status_code == 200
    filters = mock_list.call_args.kwargs["filters"]
    assert ("status", "==", "new") in filters
    assert ("source_id", "==", "source-001") in filters


@pytest.mark.asyncio
async def test_list_leads_filters_by_min_score(client):
    leads = [fake_lead({"id": "high", "relevance_score": 0.9}), fake_lead({"id": "low", "relevance_score": 0.3})]
    with patch(
        "app.routers.leads.leads_repo.list", new_callable=AsyncMock, return_value=leads,
    ):
        resp = await client.get(API, params={"min_score": 0.6})

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == "high"


@pytest.mark.asyncio
async def test_get_lead_returns_404_when_missing(client):
    with patch(
        "app.routers.leads.leads_repo.get_or_404", new_callable=AsyncMock, side_effect=KeyError("leads/x"),
    ):
        resp = await client.get(f"{API}/does-not-exist")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_lead_rejects_other_users_lead(client):
    other_users_lead = fake_lead({"user_id": "someone-else"})
    with patch(
        "app.routers.leads.leads_repo.get_or_404", new_callable=AsyncMock, return_value=other_users_lead,
    ):
        resp = await client.get(f"{API}/lead-001")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_get_lead_returns_lead(client):
    with patch(
        "app.routers.leads.leads_repo.get_or_404", new_callable=AsyncMock, return_value=fake_lead(),
    ):
        resp = await client.get(f"{API}/lead-001")
    assert resp.status_code == 200
    assert resp.json()["id"] == "lead-001"


@pytest.mark.asyncio
async def test_list_leads_requires_auth():
    from app.main import app as fastapi_app
    from httpx import AsyncClient, ASGITransport

    original_overrides = fastapi_app.dependency_overrides.copy()
    fastapi_app.dependency_overrides.clear()
    try:
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app),
            base_url="http://testserver",
        ) as ac:
            resp = await ac.get(API)
        assert resp.status_code in (401, 403)
    finally:
        fastapi_app.dependency_overrides.update(original_overrides)
