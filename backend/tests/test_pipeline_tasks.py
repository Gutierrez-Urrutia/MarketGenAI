"""Unit tests for the pipeline task execution in app/workers/tasks/pipeline_tasks.py.

Verifies:
- run_job_scout_now executes scanning, finalization, and always releases the lock.
- run_job_scout_now fails cleanly when scan crashes, marking the run failed and releasing the lock.
- run_job_scout_now skips already finished runs cleanly.
- task_run_job_scout delegates to run_job_scout_now via Celery task execution.
- _run handles missing or closed event loop safely in worker threads.
- Lock release upon Celery run completion.
- Lock expiry and recovery after 360 seconds when a worker dies mid-run.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.core.pipeline_constants import RUN_CONSIDERED_DEAD_AFTER_SECONDS
from app.schemas.pipeline import PipelineRunStatus
from app.services.firestore_service import PipelineRunLocksRepo
from app.workers.tasks import pipeline_tasks
from tests.test_pipeline_config import fake_config, fake_source
from tests.test_pipeline_runs import fake_run

SCAN_RESULT = {"leads_found": 3, "leads_new": 2, "errors": [], "partial": False}


@pytest.fixture
def mock_pipeline_env():
    with (
        patch.object(pipeline_tasks.pipeline_runs_repo, "get", new_callable=AsyncMock) as get_run,
        patch.object(pipeline_tasks.job_scout_service, "scan_all_sources", new_callable=AsyncMock, return_value=SCAN_RESULT) as scan,
        patch.object(pipeline_tasks.job_scout_service, "finalize_run", new_callable=AsyncMock) as finalize,
        patch.object(pipeline_tasks.job_scout_service, "fail_run", new_callable=AsyncMock) as fail,
        patch.object(pipeline_tasks.pipeline_run_locks_repo, "release", new_callable=AsyncMock) as release,
    ):
        get_run.return_value = fake_run({"status": PipelineRunStatus.RUNNING.value})
        yield get_run, scan, finalize, fail, release


@pytest.mark.asyncio
async def test_run_job_scout_now_success(mock_pipeline_env):
    get_run, scan, finalize, fail, release = mock_pipeline_env
    config = fake_config({"id": "cfg-1", "sources": [fake_source({"enabled": True})]})

    result = await pipeline_tasks.run_job_scout_now("run-001", config)

    assert result == SCAN_RESULT
    scan.assert_awaited_once_with(config, "run-001")
    finalize.assert_awaited_once_with("run-001", SCAN_RESULT)
    fail.assert_not_awaited()
    release.assert_awaited_once_with("cfg-1", "run-001")


@pytest.mark.asyncio
async def test_run_job_scout_now_skips_when_not_running(mock_pipeline_env):
    get_run, scan, finalize, fail, release = mock_pipeline_env
    get_run.return_value = fake_run({"status": PipelineRunStatus.COMPLETED.value})
    config = fake_config({"id": "cfg-1"})

    result = await pipeline_tasks.run_job_scout_now("run-001", config)

    assert result == {}
    scan.assert_not_awaited()
    finalize.assert_not_awaited()
    fail.assert_not_awaited()
    release.assert_awaited_once_with("cfg-1", "run-001")


@pytest.mark.asyncio
async def test_run_job_scout_now_failure_marks_run_failed_and_releases_lock(mock_pipeline_env):
    get_run, scan, finalize, fail, release = mock_pipeline_env
    scan.side_effect = RuntimeError("Scraper network error")
    config = fake_config({"id": "cfg-1"})

    with pytest.raises(RuntimeError, match="Scraper network error"):
        await pipeline_tasks.run_job_scout_now("run-001", config)

    finalize.assert_not_awaited()
    fail.assert_awaited_once_with("run-001", "Scraper network error")
    release.assert_awaited_once_with("cfg-1", "run-001")


def test_task_run_job_scout_celery_execution_success(mock_pipeline_env):
    get_run, scan, finalize, fail, release = mock_pipeline_env
    config = fake_config({"id": "cfg-1"})

    res = pipeline_tasks.task_run_job_scout.apply(args=("run-001", config)).get()

    assert res == SCAN_RESULT
    scan.assert_awaited_once()
    finalize.assert_awaited_once()
    release.assert_awaited_once_with("cfg-1", "run-001")


def test_task_run_job_scout_celery_execution_failure_releases_lock(mock_pipeline_env):
    get_run, scan, finalize, fail, release = mock_pipeline_env
    scan.side_effect = RuntimeError("DeepSeek quota exceeded")
    config = fake_config({"id": "cfg-1"})

    res = pipeline_tasks.task_run_job_scout.apply(args=("run-001", config)).get()

    assert res is None
    fail.assert_awaited_once_with("run-001", "DeepSeek quota exceeded")
    release.assert_awaited_once_with("cfg-1", "run-001")


def test_run_helper_creates_new_event_loop_when_needed():
    """Verify _run handles missing or closed loop cleanly in Celery worker thread."""
    async def sample_coro():
        await asyncio.sleep(0.01)
        return "ok"

    res = pipeline_tasks._run(sample_coro())
    assert res == "ok"


def test_worker_death_stale_lock_expiry_state_machine():
    """Verify that if a worker dies mid-run without releasing the lock,
    the lock expires after RUN_CONSIDERED_DEAD_AFTER_SECONDS (360s)."""
    now = datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc)
    lock_doc = {
        "id": "cfg-1",
        "runId": "run-dead",
        "released": False,
        "acquiredAt": now,
        "expiresAt": now + timedelta(seconds=RUN_CONSIDERED_DEAD_AFTER_SECONDS),
    }

    # At t = 100s: worker still presumed alive -> lock is held
    check_during_run = now + timedelta(seconds=100)
    assert PipelineRunLocksRepo.lock_state(lock_doc, check_during_run) == "held"

    # At t = 359s: worker still presumed alive -> lock is held
    check_almost_dead = now + timedelta(seconds=RUN_CONSIDERED_DEAD_AFTER_SECONDS - 1)
    assert PipelineRunLocksRepo.lock_state(lock_doc, check_almost_dead) == "held"

    # At t = 360s: worker considered dead -> lock becomes stale
    check_exact_dead = now + timedelta(seconds=RUN_CONSIDERED_DEAD_AFTER_SECONDS)
    assert PipelineRunLocksRepo.lock_state(lock_doc, check_exact_dead) == "stale"

    # At t = 400s: well past the TTL -> lock is stale and can be claimed by a new run
    check_past_dead = now + timedelta(seconds=400)
    assert PipelineRunLocksRepo.lock_state(lock_doc, check_past_dead) == "stale"
