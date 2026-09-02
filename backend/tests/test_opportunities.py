"""Tests for the /api/v1/opportunities router."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.routers.opportunities import _compute_score
from tests.conftest import FAKE_USER_SUB

API = "/api/v1/opportunities"


def fake_opportunity(overrides: dict | None = None) -> dict:
    base = {
        "id": "opportunity-001",
        "userId": FAKE_USER_SUB,
        "company": "FinServe Co",
        "job": "Back office automation",
        "contact": "Avery Lee",
        "role": "VP Operations",
        "stage": "Detected",
        "source": "Manual",
        "kw": ["data entry"],
        "content": "Needs finance operations support",
        "date": "2024-01-01",
        "contactEmail": "",
        "score": 23,
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-01T00:00:00Z",
    }
    if overrides:
        base.update(overrides)
    return base


def test_compute_score_exact_high_case():
    assert _compute_score({
        "kw": ["data entry", "back office"],
        "stage": "Replied",
        "contact": "Avery Lee",
        "contactEmail": "avery@example.com",
    }) == 63


def test_compute_score_exact_low_case():
    assert _compute_score({
        "kw": ["graphic design"],
        "stage": "Detected",
        "contact": "",
        "contactEmail": "",
    }) == 5


def test_compute_score_does_not_double_count_keyword_or_service():
    assert _compute_score({
        "kw": ["back office data entry", "data entry"],
        "stage": "Detected",
        "contact": "",
        "contactEmail": "",
    }) == 15


@pytest.mark.asyncio
async def test_list_opportunities_filters_by_owner_stage_and_search(client):
    opportunities = [
        fake_opportunity(),
        fake_opportunity({"id": "opportunity-002", "company": "Other Co"}),
    ]
    with patch(
        "app.routers.opportunities.opportunities_repo.list",
        new_callable=AsyncMock,
        return_value=opportunities,
    ) as list_opportunities:
        response = await client.get(f"{API}?stage=Detected&search=finserve&limit=10")

    assert response.status_code == 200
    assert [opportunity["id"] for opportunity in response.json()["items"]] == ["opportunity-001"]
    list_opportunities.assert_awaited_once_with(
        filters=[("userId", "==", FAKE_USER_SUB), ("stage", "==", "Detected")],
        order_by="updatedAt",
        order_direction="DESCENDING",
        limit=10,
    )


@pytest.mark.asyncio
async def test_create_opportunity_assigns_authenticated_user_and_computes_score(client):
    opportunity = fake_opportunity({
        "stage": "Replied",
        "kw": ["data entry", "back office"],
        "contactEmail": "avery@example.com",
        "score": 63,
    })
    payload = {
        "company": "FinServe Co",
        "job": "Back office automation",
        "stage": "Replied",
        "kw": ["data entry", "back office"],
        "contact": "Avery Lee",
        "contactEmail": "avery@example.com",
    }
    with patch(
        "app.routers.opportunities.opportunities_repo.create",
        new_callable=AsyncMock,
        return_value=opportunity,
    ) as create_opportunity:
        response = await client.post(API, json=payload)

    assert response.status_code == 201
    assert response.json()["score"] == 63
    create_opportunity.assert_awaited_once_with({
        "company": "FinServe Co",
        "job": "Back office automation",
        "contact": "Avery Lee",
        "role": "",
        "stage": "Replied",
        "source": "",
        "kw": ["data entry", "back office"],
        "content": "",
        "date": "",
        "contactEmail": "avery@example.com",
        "userId": FAKE_USER_SUB,
        "score": 63,
    })


@pytest.mark.asyncio
async def test_create_opportunity_ignores_body_score_and_recalculates(client):
    opportunity = fake_opportunity({
        "kw": ["graphic design"],
        "contact": "",
        "score": 5,
    })
    with patch(
        "app.routers.opportunities.opportunities_repo.create",
        new_callable=AsyncMock,
        return_value=opportunity,
    ) as create_opportunity:
        response = await client.post(
            API,
            json={
                "company": "Design Co",
                "job": "Creative operations",
                "kw": ["graphic design"],
                "score": 100,
            },
        )

    assert response.status_code == 201
    create_opportunity.assert_awaited_once()
    assert create_opportunity.await_args.args[0]["score"] == 5


@pytest.mark.asyncio
async def test_create_opportunity_rejects_managed_fields(client):
    response = await client.post(
        API,
        json={
            "company": "Injected Co",
            "job": "Injected Job",
            "userId": "other-user",
            "createdAt": "2024-01-01T00:00:00Z",
        },
    )

    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["New", "Archived", "InConversation"])
async def test_create_opportunity_validates_stage(client, stage):
    response = await client.post(
        API,
        json={"company": "Bad Stage Co", "job": "Ops", "stage": stage},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_get_opportunity_not_found(client):
    with patch(
        "app.routers.opportunities.opportunities_repo.get_or_404",
        new_callable=AsyncMock,
        side_effect=KeyError,
    ):
        response = await client.get(f"{API}/missing")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_get_opportunity_forbidden(client):
    with patch(
        "app.routers.opportunities.opportunities_repo.get_or_404",
        new_callable=AsyncMock,
        return_value=fake_opportunity({"userId": "other-user"}),
    ):
        response = await client.get(f"{API}/opportunity-001")

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_update_opportunity_recomputes_score(client):
    updated = fake_opportunity({
        "stage": "Replied",
        "contactEmail": "avery@example.com",
        "score": 53,
    })
    with (
        patch(
            "app.routers.opportunities.opportunities_repo.get_or_404",
            new_callable=AsyncMock,
            return_value=fake_opportunity({"stage": "Detected", "kw": ["data entry"]}),
        ),
        patch(
            "app.routers.opportunities.opportunities_repo.update",
            new_callable=AsyncMock,
            return_value=updated,
        ) as update_opportunity,
    ):
        response = await client.put(
            f"{API}/opportunity-001",
            json={"stage": "Replied", "contactEmail": "avery@example.com", "score": 100},
        )

    assert response.status_code == 200
    assert response.json()["score"] == 53
    update_opportunity.assert_awaited_once_with(
        "opportunity-001",
        {"stage": "Replied", "contactEmail": "avery@example.com", "score": 53},
    )


@pytest.mark.asyncio
async def test_update_opportunity_rejects_empty_body(client):
    with patch(
        "app.routers.opportunities.opportunities_repo.get_or_404",
        new_callable=AsyncMock,
        return_value=fake_opportunity(),
    ):
        response = await client.put(f"{API}/opportunity-001", json={})

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_update_opportunity_rejects_score_only_body(client):
    with patch(
        "app.routers.opportunities.opportunities_repo.get_or_404",
        new_callable=AsyncMock,
        return_value=fake_opportunity(),
    ):
        response = await client.put(f"{API}/opportunity-001", json={"score": 100})

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_delete_opportunity(client):
    with (
        patch(
            "app.routers.opportunities.opportunities_repo.get_or_404",
            new_callable=AsyncMock,
            return_value=fake_opportunity(),
        ),
        patch(
            "app.routers.opportunities.opportunities_repo.delete",
            new_callable=AsyncMock,
            return_value=None,
        ) as delete_opportunity,
    ):
        response = await client.delete(f"{API}/opportunity-001")

    assert response.status_code == 204
    delete_opportunity.assert_awaited_once_with("opportunity-001")
