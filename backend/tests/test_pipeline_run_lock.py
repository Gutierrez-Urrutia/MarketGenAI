"""One active PipelineRun per PipelineConfig — enforced by the backend."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import FAKE_USER_SUB
from tests.test_pipeline_config import fake_config, fake_source
from tests.test_pipeline_runs import API, fake_run

ROUTER = "app.routers.pipeline"


@pytest.fixture
def lock():
    """Explicit lock mocks (override the autouse ones in test_pipeline_runs)."""
    with (
        patch(f"{ROUTER}.pipeline_run_locks_repo.try_acquire", new_callable=AsyncMock) as acquire,
        patch(f"{ROUTER}.pipeline_run_locks_repo.release", new_callable=AsyncMock) as release,
    ):
        acquire.return_value = {"acquired": True, "holder_run_id": None, "stale_run_id": None}
        yield type("Lock", (), {"acquire": acquire, "release": release})


@pytest.fixture
def enabled_config():
    doc = fake_config({"sources": [fake_source({"enabled": True})]})
    with patch(f"{ROUTER}.pipeline_configs_repo.get_by_user", new_callable=AsyncMock, return_value=doc):
        yield doc


@pytest.mark.asyncio
async def test_second_run_is_rejected_with_409(client, lock, enabled_config):
    lock.acquire.return_value = {"acquired": False, "holder_run_id": "run-active", "stale_run_id": None}
    with (
        patch(f"{ROUTER}.pipeline_runs_repo.create", new_callable=AsyncMock) as mock_create,
        patch(f"{ROUTER}.task_run_job_scout") as mock_task,
    ):
        resp = await client.post(API)

    assert resp.status_code == 409
    assert resp.json()["detail"]["run_id"] == "run-active"
    mock_create.assert_not_awaited()  # no second run doc
    mock_task.delay.assert_not_called()  # nothing enqueued on top of the first


@pytest.mark.asyncio
async def test_lock_is_taken_with_dead_run_threshold_and_owned_by_the_new_run(client, lock, enabled_config):
    from app.core.pipeline_constants import RUN_CONSIDERED_DEAD_AFTER_SECONDS

    with (
        patch(f"{ROUTER}.pipeline_runs_repo.create", new_callable=AsyncMock, return_value=fake_run()) as mock_create,
        patch(f"{ROUTER}.task_run_job_scout"),
    ):
        resp = await client.post(API)

    assert resp.status_code == 202
    config_id, run_id, ttl = lock.acquire.call_args.args
    assert config_id == FAKE_USER_SUB
    assert ttl == RUN_CONSIDERED_DEAD_AFTER_SECONDS == 360  # 6 minutes
    assert mock_create.call_args.kwargs["doc_id"] == run_id
    lock.release.assert_not_awaited()  # Celery path: the task releases it, not the request


@pytest.mark.asyncio
async def test_sync_fallback_releases_lock_after_scan(client, lock, enabled_config):
    with (
        patch(f"{ROUTER}.pipeline_runs_repo.create", new_callable=AsyncMock, return_value=fake_run()),
        patch(f"{ROUTER}.task_run_job_scout") as mock_task,
        patch(
            f"{ROUTER}.job_scout_service.scan_all_sources", new_callable=AsyncMock,
            return_value={"leads_found": 0, "leads_new": 0, "errors": [], "partial": False},
        ),
        patch(f"{ROUTER}.job_scout_service.finalize_run", new_callable=AsyncMock),
    ):
        mock_task.delay.side_effect = ConnectionError("Redis unreachable")
        resp = await client.post(API)

    assert resp.status_code == 202
    lock.release.assert_awaited_once()


@pytest.mark.asyncio
async def test_sync_fallback_releases_lock_when_scan_crashes(client, lock, enabled_config):
    with (
        patch(f"{ROUTER}.pipeline_runs_repo.create", new_callable=AsyncMock, return_value=fake_run()),
        patch(f"{ROUTER}.task_run_job_scout") as mock_task,
        patch(f"{ROUTER}.job_scout_service.scan_all_sources", new_callable=AsyncMock, side_effect=RuntimeError("boom")),
        patch(f"{ROUTER}.job_scout_service.fail_run", new_callable=AsyncMock) as mock_fail,
    ):
        mock_task.delay.side_effect = ConnectionError("Redis unreachable")
        with pytest.raises(RuntimeError):
            await client.post(API)

    mock_fail.assert_awaited_once()
    lock.release.assert_awaited_once()  # a crashed run must not lock the config


@pytest.mark.asyncio
async def test_lock_is_released_if_run_doc_creation_fails(client, lock, enabled_config):
    with patch(
        f"{ROUTER}.pipeline_runs_repo.create", new_callable=AsyncMock, side_effect=RuntimeError("firestore down"),
    ):
        with pytest.raises(RuntimeError):
            await client.post(API)

    lock.release.assert_awaited_once()


@pytest.mark.asyncio
async def test_stale_run_taken_over_is_closed_out(client, lock, enabled_config):
    lock.acquire.return_value = {"acquired": True, "holder_run_id": None, "stale_run_id": "run-dead"}
    with (
        patch(f"{ROUTER}.pipeline_runs_repo.create", new_callable=AsyncMock, return_value=fake_run()),
        patch(f"{ROUTER}.task_run_job_scout"),
        patch(f"{ROUTER}.job_scout_service.fail_run", new_callable=AsyncMock) as mock_fail,
    ):
        resp = await client.post(API)

    assert resp.status_code == 202
    assert mock_fail.await_args.args[0] == "run-dead"


@pytest.mark.asyncio
async def test_active_endpoint_returns_the_running_run(client, enabled_config):
    with (
        patch(f"{ROUTER}.pipeline_run_locks_repo.get_active_run_id", new_callable=AsyncMock, return_value="run-001"),
        patch(f"{ROUTER}.pipeline_runs_repo.get", new_callable=AsyncMock, return_value=fake_run()),
    ):
        resp = await client.get(f"{API}/active")

    assert resp.status_code == 200
    assert resp.json()["run"]["id"] == "run-001"


@pytest.mark.asyncio
async def test_active_endpoint_returns_null_without_a_live_lock(client, enabled_config):
    with patch(f"{ROUTER}.pipeline_run_locks_repo.get_active_run_id", new_callable=AsyncMock, return_value=None):
        resp = await client.get(f"{API}/active")

    assert resp.status_code == 200
    assert resp.json() == {"run": None}


@pytest.mark.asyncio
@pytest.mark.parametrize("run", [fake_run({"status": "completed"}), fake_run({"user_id": "someone-else"})])
async def test_active_endpoint_ignores_finished_or_foreign_runs(client, enabled_config, run):
    with (
        patch(f"{ROUTER}.pipeline_run_locks_repo.get_active_run_id", new_callable=AsyncMock, return_value="run-001"),
        patch(f"{ROUTER}.pipeline_runs_repo.get", new_callable=AsyncMock, return_value=run),
    ):
        resp = await client.get(f"{API}/active")

    assert resp.json() == {"run": None}


def test_lock_state_machine():
    """Pure decision logic the Firestore transaction wraps."""
    from app.services.firestore_service import PipelineRunLocksRepo

    now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
    state = PipelineRunLocksRepo.lock_state
    assert state(None, now) == "free"
    assert state({"released": True, "expiresAt": now + timedelta(minutes=5)}, now) == "free"
    assert state({"released": False, "expiresAt": now + timedelta(seconds=1)}, now) == "held"
    assert state({"released": False, "expiresAt": now}, now) == "stale"
    assert state({"released": False, "expiresAt": now - timedelta(minutes=10)}, now) == "stale"
    assert state({"released": False}, now) == "stale"  # a malformed lock never blocks forever
