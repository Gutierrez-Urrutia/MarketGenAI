"""Tests for the /api/v1/campaigns router."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import FAKE_USER_SUB

API = "/api/v1/campaigns"


def fake_campaign(overrides: dict | None = None) -> dict:
    base = {
        "id": "campaign-001",
        "userId": FAKE_USER_SUB,
        "name": "Launch Campaign",
        "audience": "B2B marketing leaders",
        "objective": "Generate qualified leads",
        "context": "Product launch",
        "channels": ["linkedin"],
        "status": "draft",
        "briefData": {"step": 1},
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-01T00:00:00Z",
    }
    if overrides:
        base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_list_campaigns_filters_by_owner_status_and_search(client):
    campaigns = [
        fake_campaign(),
        fake_campaign({"id": "campaign-002", "name": "Other Campaign"}),
    ]
    with patch(
        "app.routers.campaigns.campaigns_repo.list",
        new_callable=AsyncMock,
        return_value=campaigns,
    ) as list_campaigns:
        response = await client.get(f"{API}?status=draft&search=launch&limit=10")

    assert response.status_code == 200
    assert [campaign["id"] for campaign in response.json()] == ["campaign-001"]
    list_campaigns.assert_awaited_once_with(
        filters=[("userId", "==", FAKE_USER_SUB), ("status", "==", "draft")],
        order_by="updatedAt",
        order_direction="DESCENDING",
        limit=10,
    )


@pytest.mark.asyncio
async def test_create_campaign_assigns_authenticated_user_and_defaults(client):
    campaign = fake_campaign()
    with patch(
        "app.routers.campaigns.campaigns_repo.create",
        new_callable=AsyncMock,
        return_value=campaign,
    ) as create_campaign:
        response = await client.post(API, json={"name": "Launch Campaign"})

    assert response.status_code == 201
    assert response.json()["userId"] == FAKE_USER_SUB
    create_campaign.assert_awaited_once_with(
        {
            "name": "Launch Campaign",
            "audience": "",
            "objective": "",
            "context": "",
            "channels": ["linkedin"],
            "status": "draft",
            "briefData": None,
            "userId": FAKE_USER_SUB,
        }
    )


@pytest.mark.asyncio
async def test_create_campaign_rejects_managed_fields(client):
    response = await client.post(
        API,
        json={
            "name": "Injected Campaign",
            "userId": "other-user",
            "createdAt": "2024-01-01T00:00:00Z",
        },
    )

    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"name": "Bad Channel", "channels": ["email"]},
        {"name": "Removed Channel", "channels": ["instagram"]},
        {"name": "Bad Status", "status": "archived"},
    ],
)
async def test_create_campaign_validates_channels_and_status(client, payload):
    response = await client.post(API, json=payload)

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_campaign_accepts_email_outreach(client):
    campaign = fake_campaign({"channels": ["email_outreach"]})
    with patch(
        "app.routers.campaigns.campaigns_repo.create",
        new_callable=AsyncMock,
        return_value=campaign,
    ):
        response = await client.post(
            API,
            json={"name": "Email Campaign", "channels": ["email_outreach"]},
        )

    assert response.status_code == 201
    assert response.json()["channels"] == ["email_outreach"]


@pytest.mark.asyncio
async def test_generate_campaign_content_creates_owned_asset_and_job(client):
    campaign = fake_campaign({"status": "active", "channels": ["linkedin"]})
    asset = {
        "id": "asset-001",
        "type": "campaign_content",
        "campaignId": campaign["id"],
        "userId": FAKE_USER_SUB,
        "status": "generating",
        "title": "AI Campaign Content - Launch Campaign",
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-01T00:00:00Z",
    }
    ready_asset = {**asset, "status": "ready", "content": "[]"}
    job = {"id": "job-001"}

    with (
        patch(
            "app.routers.campaigns.campaigns_repo.get_or_404",
            new_callable=AsyncMock,
            return_value=campaign,
        ),
        patch(
            "app.routers.campaigns.assets_repo.create",
            new_callable=AsyncMock,
            return_value=asset,
        ) as create_asset,
        patch(
            "app.routers.campaigns.assets_repo.update",
            new_callable=AsyncMock,
            return_value=ready_asset,
        ) as update_asset,
        patch(
            "app.routers.campaigns.jobs_repo.create_job",
            new_callable=AsyncMock,
            return_value=job,
        ),
        patch("app.routers.campaigns.jobs_repo.update_progress", new_callable=AsyncMock),
        patch("app.routers.campaigns.jobs_repo.complete_job", new_callable=AsyncMock) as complete_job,
        patch("app.routers.campaigns.campaigns_repo.update", new_callable=AsyncMock),
        patch(
            "app.routers.campaigns.deepseek_service.generate_text",
            new_callable=AsyncMock,
            return_value='{"posts":[{"channel":"linkedin","headline":"Launch","content":"Generated post","hashtags":["#AI"]}]}',
        ) as generate_content,
    ):
        response = await client.post(f"{API}/campaign-001/generate")

    assert response.status_code == 201
    assert response.json()["asset"]["status"] == "ready"
    create_asset.assert_awaited_once()
    generate_content.assert_awaited_once()
    call_args = generate_content.await_args
    assert "Launch Campaign" in call_args.args[0]
    assert "B2B marketing leaders" in call_args.args[0]
    assert "Product launch" in call_args.args[0]
    assert call_args.kwargs["system_prompt"] == "You are an expert B2B marketing copywriter."
    ready_update = update_asset.await_args_list[-1].args[1]
    assert json.loads(ready_update["content"]) == {
        "posts": [{
            "channel": "linkedin",
            "headline": "Launch",
            "content": "Generated post",
            "hashtags": ["#AI"],
        }]
    }
    complete_job.assert_awaited_once()


@pytest.mark.asyncio
async def test_campaign_generation_retries_invalid_json_then_returns_structured_posts():
    campaign = fake_campaign({"channels": ["linkedin"]})
    with (
        patch(
            "app.routers.campaigns.deepseek_service.generate_text",
            new_callable=AsyncMock,
            side_effect=[
                "not json",
                '```json\n{"posts":[{"channel":"linkedin","headline":"Launch","content":"Clean post","hashtags":["#AI"]}]}\n```',
            ],
        ) as generate_text,
        patch("app.routers.campaigns.logger.exception") as log_exception,
    ):
        result = await __import__(
            "app.routers.campaigns", fromlist=["_generate_campaign_content"]
        )._generate_campaign_content(campaign, ["linkedin"])

    assert result == {
        "posts": [{
            "channel": "linkedin",
            "headline": "Launch",
            "content": "Clean post",
            "hashtags": ["#AI"],
        }]
    }
    assert generate_text.await_count == 2
    log_exception.assert_called_once()


@pytest.mark.asyncio
async def test_campaign_generation_falls_back_to_plain_text_after_invalid_json():
    campaign = fake_campaign({"channels": ["linkedin", "substack"]})
    with (
        patch(
            "app.routers.campaigns.deepseek_service.generate_text",
            new_callable=AsyncMock,
            side_effect=["bad response", "Legacy **campaign** text"],
        ),
        patch("app.routers.campaigns.logger.exception"),
    ):
        result = await __import__(
            "app.routers.campaigns", fromlist=["_generate_campaign_content"]
        )._generate_campaign_content(campaign, ["linkedin", "substack"])

    assert [post["channel"] for post in result["posts"]] == ["linkedin", "substack"]
    assert all(post["content"] == "Legacy **campaign** text" for post in result["posts"])


@pytest.mark.asyncio
async def test_generate_campaign_content_enforces_ownership(client):
    with patch(
        "app.routers.campaigns.campaigns_repo.get_or_404",
        new_callable=AsyncMock,
        return_value=fake_campaign({"userId": "other-user"}),
    ):
        response = await client.post(f"{API}/campaign-001/generate")

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_generate_campaign_content_logs_error_and_returns_generic_502(client):
    campaign = fake_campaign({"status": "active"})
    asset = {"id": "asset-001"}
    job = {"id": "job-001"}

    with (
        patch(
            "app.routers.campaigns.campaigns_repo.get_or_404",
            new_callable=AsyncMock,
            return_value=campaign,
        ),
        patch(
            "app.routers.campaigns.assets_repo.create",
            new_callable=AsyncMock,
            return_value=asset,
        ),
        patch("app.routers.campaigns.assets_repo.update", new_callable=AsyncMock),
        patch(
            "app.routers.campaigns.jobs_repo.create_job",
            new_callable=AsyncMock,
            return_value=job,
        ),
        patch("app.routers.campaigns.jobs_repo.update_progress", new_callable=AsyncMock),
        patch("app.routers.campaigns.jobs_repo.fail_job", new_callable=AsyncMock),
        patch("app.routers.campaigns.campaigns_repo.update", new_callable=AsyncMock),
        patch(
            "app.routers.campaigns.deepseek_service.generate_text",
            new_callable=AsyncMock,
            side_effect=RuntimeError("secret provider failure"),
        ),
        patch("app.routers.campaigns.logger.exception") as log_exception,
    ):
        response = await client.post(f"{API}/campaign-001/generate")

    assert response.status_code == 502
    assert response.json() == {
        "detail": "Campaign was saved, but AI content generation failed."
    }
    assert "secret provider failure" not in response.text
    log_exception.assert_called_once()


@pytest.mark.asyncio
async def test_get_campaign_not_found(client):
    with patch(
        "app.routers.campaigns.campaigns_repo.get_or_404",
        new_callable=AsyncMock,
        side_effect=KeyError,
    ):
        response = await client.get(f"{API}/missing")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_get_campaign_forbidden(client):
    with patch(
        "app.routers.campaigns.campaigns_repo.get_or_404",
        new_callable=AsyncMock,
        return_value=fake_campaign({"userId": "other-user"}),
    ):
        response = await client.get(f"{API}/campaign-001")

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_update_campaign(client):
    updated = fake_campaign({"status": "active"})
    with (
        patch(
            "app.routers.campaigns.campaigns_repo.get_or_404",
            new_callable=AsyncMock,
            return_value=fake_campaign(),
        ),
        patch(
            "app.routers.campaigns.campaigns_repo.update",
            new_callable=AsyncMock,
            return_value=updated,
        ) as update_campaign,
    ):
        response = await client.put(f"{API}/campaign-001", json={"status": "active"})

    assert response.status_code == 200
    assert response.json()["status"] == "active"
    update_campaign.assert_awaited_once_with("campaign-001", {"status": "active"})


@pytest.mark.asyncio
async def test_update_campaign_rejects_empty_body(client):
    with patch(
        "app.routers.campaigns.campaigns_repo.get_or_404",
        new_callable=AsyncMock,
        return_value=fake_campaign(),
    ):
        response = await client.put(f"{API}/campaign-001", json={})

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_delete_campaign(client):
    with (
        patch(
            "app.routers.campaigns.campaigns_repo.get_or_404",
            new_callable=AsyncMock,
            return_value=fake_campaign(),
        ),
        patch(
            "app.routers.campaigns.campaigns_repo.delete",
            new_callable=AsyncMock,
            return_value=None,
        ) as delete_campaign,
    ):
        response = await client.delete(f"{API}/campaign-001")

    assert response.status_code == 204
    delete_campaign.assert_awaited_once_with("campaign-001")
