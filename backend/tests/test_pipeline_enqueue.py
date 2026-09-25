"""Handing a run to Celery must never stall the event loop (Redis unreachable case).

Regression: `task.delay()` is synchronous and, with the broker down, retries the
connection for ~2 minutes (measured 108.8 s, 44 attempts). Called straight from
the async handler it froze the whole API, so concurrent requests were served
only when it gave up. The blocking is simulated here with time.sleep.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.test_pipeline_config import fake_config, fake_source
from tests.test_pipeline_runs import API, fake_run

ROUTER = "app.routers.pipeline"
SCAN_RESULT = {"leads_found": 0, "leads_new": 0, "errors": [], "partial": False}


@pytest.fixture
def scan_env():
    """Everything the request touches, mocked; yields the scan/finalize mocks."""
    doc = fake_config({"sources": [fake_source({"enabled": True})]})
    with (
        patch(f"{ROUTER}.pipeline_configs_repo.get_by_user", new_callable=AsyncMock, return_value=doc),
        patch(f"{ROUTER}.pipeline_runs_repo.create", new_callable=AsyncMock, return_value=fake_run()),
        patch(f"{ROUTER}.pipeline_runs_repo.list", new_callable=AsyncMock, return_value=[]),
        patch(
            f"{ROUTER}.pipeline_run_locks_repo.try_acquire", new_callable=AsyncMock,
            return_value={"acquired": True, "holder_run_id": None, "stale_run_id": None},
        ),
        patch(f"{ROUTER}.pipeline_run_locks_repo.release", new_callable=AsyncMock),
        patch(f"{ROUTER}.job_scout_service.scan_all_sources", new_callable=AsyncMock, return_value=SCAN_RESULT) as scan,
        patch(f"{ROUTER}.job_scout_service.finalize_run", new_callable=AsyncMock),
    ):
        yield scan


def _blocking_delay(seconds: float, then_raise: bool = True):
    def delay(*args, **kwargs):
        time.sleep(seconds)  # what an unreachable Redis does inside .delay()
        if then_raise:
            raise ConnectionError("Redis unreachable")
    return delay


@pytest.mark.asyncio
async def test_unreachable_redis_falls_back_inside_the_cap_without_stalling_the_loop(client, scan_env):
    BLOCK, CAP = 2.5, 0.3
    stall = {"max": 0.0}

    async def heartbeat():
        last = time.monotonic()
        while True:
            await asyncio.sleep(0.02)
            now = time.monotonic()
            stall["max"] = max(stall["max"], now - last - 0.02)
            last = now

    async def other_request_during_the_block():
        await asyncio.sleep(0.1)  # .delay() is already blocked in its thread
        t0 = time.monotonic()
        resp = await client.get(API)
        return resp.status_code, time.monotonic() - t0

    with (
        patch(f"{ROUTER}.task_run_job_scout") as mock_task,
        patch(f"{ROUTER}.TASK_ENQUEUE_TIMEOUT_SECONDS", CAP),
    ):
        mock_task.delay.side_effect = _blocking_delay(BLOCK)
        hb = asyncio.create_task(heartbeat())
        t0 = time.monotonic()
        post, (other_status, other_latency) = await asyncio.gather(
            client.post(API), other_request_during_the_block(),
        )
        elapsed = time.monotonic() - t0
        hb.cancel()

    assert post.status_code == 202
    scan_env.assert_awaited_once()                 # the inline fallback ran
    assert elapsed < BLOCK - 0.5                   # inside the cap, not after the 2.5 s block
    assert stall["max"] < 0.25                     # the event loop never stopped
    assert other_status == 200
    assert other_latency < 0.5                     # another user was served while .delay() hung


@pytest.mark.asyncio
async def test_fast_broker_error_falls_back_inline(client, scan_env):
    with patch(f"{ROUTER}.task_run_job_scout") as mock_task:
        mock_task.delay.side_effect = ConnectionError("Redis unreachable")
        resp = await client.post(API)

    assert resp.status_code == 202
    scan_env.assert_awaited_once()


@pytest.mark.asyncio
async def test_queued_run_does_not_scan_inline(client, scan_env):
    with patch(f"{ROUTER}.task_run_job_scout") as mock_task:
        resp = await client.post(API)

    assert resp.status_code == 202
    mock_task.delay.assert_called_once()
    scan_env.assert_not_awaited()


@pytest.mark.asyncio
async def test_slow_but_successful_publish_is_treated_as_unavailable_after_the_cap(client, scan_env):
    """Publish that would eventually succeed but exceeds the cap: the request
    stops waiting and scans inline (the late task is then skipped by the guard)."""
    with (
        patch(f"{ROUTER}.task_run_job_scout") as mock_task,
        patch(f"{ROUTER}.TASK_ENQUEUE_TIMEOUT_SECONDS", 0.2),
    ):
        mock_task.delay.side_effect = _blocking_delay(1.0, then_raise=False)
        t0 = time.monotonic()
        resp = await client.post(API)
        elapsed = time.monotonic() - t0

    assert resp.status_code == 202
    scan_env.assert_awaited_once()
    assert elapsed < 0.9


# ── The Celery task must not re-run a run that was already scanned inline ────
@pytest.fixture
def task_env():
    asyncio.set_event_loop(asyncio.new_event_loop())  # the task drives coroutines with get_event_loop()
    from app.workers.tasks import pipeline_tasks

    with (
        patch.object(pipeline_tasks.pipeline_runs_repo, "get", new_callable=AsyncMock) as get_run,
        patch.object(pipeline_tasks.job_scout_service, "scan_all_sources", new_callable=AsyncMock, return_value=SCAN_RESULT) as scan,
        patch.object(pipeline_tasks.job_scout_service, "finalize_run", new_callable=AsyncMock) as finalize,
        patch.object(pipeline_tasks.pipeline_run_locks_repo, "release", new_callable=AsyncMock) as release,
    ):
        yield pipeline_tasks, get_run, scan, finalize, release


def test_task_skips_a_run_that_is_no_longer_running(task_env):
    pipeline_tasks, get_run, scan, finalize, release = task_env
    get_run.return_value = fake_run({"status": "completed"})

    pipeline_tasks.task_run_job_scout.apply(args=("run-001", {"id": "cfg-1"})).get()

    scan.assert_not_awaited()      # already scanned inline: no second scan of the same run
    finalize.assert_not_awaited()
    release.assert_awaited_once()  # lock release is owner-checked, so this is harmless


def test_task_skips_a_missing_run(task_env):
    pipeline_tasks, get_run, scan, finalize, release = task_env
    get_run.return_value = None

    pipeline_tasks.task_run_job_scout.apply(args=("run-001", {"id": "cfg-1"})).get()

    scan.assert_not_awaited()


def test_task_scans_a_run_that_is_still_running(task_env):
    pipeline_tasks, get_run, scan, finalize, release = task_env
    get_run.return_value = fake_run({"status": "running"})

    pipeline_tasks.task_run_job_scout.apply(args=("run-001", {"id": "cfg-1"})).get()

    scan.assert_awaited_once()
    finalize.assert_awaited_once()
    release.assert_awaited_once()
