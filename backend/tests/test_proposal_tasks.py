"""
Unit tests for the proposal generation tasks in
app/workers/tasks/proposal_tasks.py.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from celery.exceptions import Retry

from app.workers.tasks import proposal_tasks


@pytest.mark.asyncio
async def test_generate_proposal_now_success():
    options = {
        "detailedDescription": "Automate invoice reconciliation",
        "teamSizing": "1 lead, 2 analysts",
        "lineItems": [
            {"service": "Workflow Setup", "quantity": 1, "unitPrice": 2500}
        ],
        "totalAmount": 2500,
        "length": "standard",
        "language": "es",
        "customPrompt": "Enfoque en ROI rápido",
    }

    generated_content = {
        "content": "<h2>Executive Summary</h2><p>Solución de IA</p>",
        "downloadUrl": "generated_files/proposal-test.md",
        "filePath": "generated_files/proposal-test.md",
    }

    with (
        patch.object(proposal_tasks.jobs_repo, "update_progress", new_callable=AsyncMock) as update_prog,
        patch.object(proposal_tasks.jobs_repo, "complete_job", new_callable=AsyncMock) as comp_job,
        patch.object(proposal_tasks.proposals_repo, "update", new_callable=AsyncMock, return_value={"id": "prop-1", "status": "generated"}) as update_prop,
        patch.object(proposal_tasks, "_generate_proposal_content", new_callable=AsyncMock, return_value=generated_content) as gen_content,
    ):
        result = await proposal_tasks.generate_proposal_now(
            "job-1",
            "prop-1",
            "Propuesta Automatización",
            "Cliente SA",
            "Descripción general",
            options,
        )

    assert result["status"] == "generated"
    assert update_prog.await_count == 2
    comp_job.assert_awaited_once_with("job-1", {"proposalId": "prop-1", "status": "generated"})
    update_prop.assert_any_await("prop-1", {"status": "generating"})
    update_prop.assert_any_await("prop-1", {
        "content": generated_content["content"],
        "downloadUrl": generated_content["downloadUrl"],
        "filePath": generated_content["filePath"],
        "status": "generated",
        "language": "es",
        "customPrompt": "Enfoque en ROI rápido",
    })
    gen_content.assert_awaited_once()


def test_task_generate_proposal_success():
    options = {"language": "es"}
    with (
        patch.object(proposal_tasks, "_run") as run_mock,
    ):
        proposal_tasks.task_generate_proposal(
            "job-1",
            "prop-1",
            "Propuesta",
            "Cliente SA",
            "Desc",
            options,
        )
    run_mock.assert_called_once()


def test_task_generate_proposal_failure_retries_and_updates_status():
    options = {"language": "es"}
    with (
        patch.object(proposal_tasks, "generate_proposal_now", new_callable=AsyncMock, side_effect=RuntimeError("LLM failure")),
        patch.object(proposal_tasks.task_generate_proposal, "retry", side_effect=Retry("Task retry triggered")) as retry_mock,
        patch.object(proposal_tasks.proposals_repo, "update", new_callable=AsyncMock) as update_mock,
        patch.object(proposal_tasks.jobs_repo, "fail_job", new_callable=AsyncMock) as fail_mock,
    ):
        with pytest.raises(Retry):
            proposal_tasks.task_generate_proposal(
                "job-1",
                "prop-1",
                "Propuesta",
                "Cliente SA",
                "Desc",
                options,
            )
    retry_mock.assert_called_once()
    update_mock.assert_awaited_once_with("prop-1", {"status": "error"})
    fail_mock.assert_awaited_once_with("job-1", "LLM failure")
