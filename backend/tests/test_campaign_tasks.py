"""
Unit tests for the campaign generation tasks in
app/workers/tasks/campaign_tasks.py.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from celery.exceptions import Retry

from app.workers.tasks import campaign_tasks
from tests.conftest import FAKE_USER_SUB


def fake_campaign(overrides: dict | None = None) -> dict:
    base = {
        "id": "campaign-001",
        "userId": FAKE_USER_SUB,
        "name": "Launch Campaign",
        "audience": "B2B marketing leaders",
        "objective": "lead_generation",
        "context": "Product launch",
        "channels": ["linkedin"],
        "status": "draft",
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-01T00:00:00Z",
    }
    if overrides:
        base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_generate_campaign_content_now_success():
    campaign = fake_campaign()
    generated_content = {
        "posts": [{
            "channel": "linkedin",
            "headline": "Launch",
            "content": "Generated post content",
            "hashtags": ["#AI"],
        }]
    }

    ready_asset = {
        "id": "asset-1",
        "status": "ready",
        "content": '{"posts": []}',
    }

    with (
        patch.object(campaign_tasks.jobs_repo, "update_progress", new_callable=AsyncMock) as update_prog,
        patch.object(campaign_tasks.jobs_repo, "complete_job", new_callable=AsyncMock) as comp_job,
        patch.object(campaign_tasks.campaigns_repo, "get_or_404", new_callable=AsyncMock, return_value=campaign),
        patch.object(campaign_tasks.campaigns_repo, "update", new_callable=AsyncMock) as update_campaign,
        patch.object(campaign_tasks.assets_repo, "update", new_callable=AsyncMock, return_value=ready_asset) as update_asset,
        patch.object(campaign_tasks, "_generate_campaign_content", new_callable=AsyncMock, return_value=generated_content) as gen_content,
    ):
        result = await campaign_tasks.generate_campaign_content_now(
            "job-1",
            "campaign-001",
            "asset-1",
            FAKE_USER_SUB,
        )

    assert result["campaignId"] == "campaign-001"
    assert result["jobId"] == "job-1"
    assert result["asset"]["status"] == "ready"
    assert update_prog.await_count == 2
    comp_job.assert_awaited_once_with("job-1", {
        "campaignId": "campaign-001",
        "jobId": "job-1",
        "assetId": "asset-1",
        "asset": ready_asset,
    })
    gen_content.assert_awaited_once()


def test_task_generate_campaign_content_success():
    with patch.object(campaign_tasks, "_run") as run_mock:
        campaign_tasks.task_generate_campaign_content(
            "job-1",
            "campaign-001",
            "asset-1",
            FAKE_USER_SUB,
        )
    run_mock.assert_called_once()


def test_task_generate_campaign_content_failure_retries_and_updates_status():
    with (
        patch.object(campaign_tasks, "generate_campaign_content_now", new_callable=AsyncMock, side_effect=RuntimeError("AI generation failed")),
        patch.object(campaign_tasks.task_generate_campaign_content, "retry", side_effect=Retry("Task retry triggered")) as retry_mock,
        patch.object(campaign_tasks.assets_repo, "update", new_callable=AsyncMock) as update_asset,
        patch.object(campaign_tasks.campaigns_repo, "update", new_callable=AsyncMock) as update_campaign,
        patch.object(campaign_tasks.jobs_repo, "fail_job", new_callable=AsyncMock) as fail_job,
    ):
        with pytest.raises(Retry):
            campaign_tasks.task_generate_campaign_content(
                "job-1",
                "campaign-001",
                "asset-1",
                FAKE_USER_SUB,
            )
    retry_mock.assert_called_once()
    update_asset.assert_awaited_once_with("asset-1", {"status": "error"})
    fail_job.assert_awaited_once_with("job-1", "AI generation failed")
