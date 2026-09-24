"""Tests for POST/GET /api/v1/pipeline/runs (Fase 2 — manual trigger only)."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import FAKE_USER_SUB
from tests.test_pipeline_config import fake_config, fake_source

API = "/api/v1/pipeline/runs"


def fake_run(overrides: dict | None = None) -> dict:
    base = {
        "id": "run-001",
        "pipeline_config_id": FAKE_USER_SUB,
        "user_id": FAKE_USER_SUB,
        "status": "running",
        "leads_found": 0,
        "leads_new": 0,
        "contacts_found": 0,
        "emails_generated": 0,
        "emails_auto_approved": 0,
        "emails_pending_review": 0,
        "emails_sent": 0,
        "started_at": None,
        "agent1_completed_at": None,
        "agent2_completed_at": None,
        "agent3_completed_at": None,
        "completed_at": None,
        "errors": [],
    }
    if overrides:
        base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_create_run_rejects_when_no_enabled_sources(client):
    with patch(
        "app.routers.pipeline.pipeline_configs_repo.get_by_user",
        new_callable=AsyncMock, return_value=fake_config({"sources": []}),
    ):
        resp = await client.post(API)
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_run_enqueues_celery_task_when_available(client):
    doc = fake_config({"sources": [fake_source({"enabled": True})]})
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=doc,
        ),
        patch(
            "app.routers.pipeline.pipeline_runs_repo.create",
            new_callable=AsyncMock, return_value=fake_run(),
        ),
        patch("app.routers.pipeline.task_run_job_scout") as mock_task,
        patch(
            "app.routers.pipeline.job_scout_service.scan_all_sources", new_callable=AsyncMock,
        ) as mock_scan,
    ):
        resp = await client.post(API)

    assert resp.status_code == 202
    assert resp.json()["job_id"] == "run-001"
    mock_task.delay.assert_called_once()
    mock_scan.assert_not_awaited()  # sync fallback must not run when Celery succeeds


@pytest.mark.asyncio
async def test_create_run_falls_back_to_sync_when_celery_unavailable(client):
    doc = fake_config({"sources": [fake_source({"enabled": True})]})
    with (
        patch(
            "app.routers.pipeline.pipeline_configs_repo.get_by_user",
            new_callable=AsyncMock, return_value=doc,
        ),
        patch(
            "app.routers.pipeline.pipeline_runs_repo.create",
            new_callable=AsyncMock, return_value=fake_run(),
        ),
        patch("app.routers.pipeline.task_run_job_scout") as mock_task,
        patch(
            "app.routers.pipeline.job_scout_service.scan_all_sources", new_callable=AsyncMock,
            return_value={"leads_found": 0, "leads_new": 0, "errors": [], "partial": False},
        ) as mock_scan,
        patch(
            "app.routers.pipeline.job_scout_service.finalize_run", new_callable=AsyncMock,
        ) as mock_finalize,
    ):
        mock_task.delay.side_effect = ConnectionError("Redis unreachable")
        resp = await client.post(API)

    assert resp.status_code == 202
    mock_scan.assert_awaited_once()
    mock_finalize.assert_awaited_once()


@pytest.mark.asyncio
async def test_list_runs_scopes_by_user(client):
    with patch(
        "app.routers.pipeline.pipeline_runs_repo.list",
        new_callable=AsyncMock, return_value=[fake_run()],
    ) as mock_list:
        resp = await client.get(API)

    assert resp.status_code == 200
    assert resp.json()["total"] == 1
    filters = mock_list.call_args.kwargs["filters"]
    assert ("user_id", "==", FAKE_USER_SUB) in filters


@pytest.mark.asyncio
async def test_get_run_rejects_other_users_run(client):
    other_run = fake_run({"user_id": "someone-else"})
    with patch(
        "app.routers.pipeline.pipeline_runs_repo.get_or_404",
        new_callable=AsyncMock, return_value=other_run,
    ):
        resp = await client.get(f"{API}/run-001")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_get_run_returns_404_when_missing(client):
    with patch(
        "app.routers.pipeline.pipeline_runs_repo.get_or_404",
        new_callable=AsyncMock, side_effect=KeyError("pipeline_runs/x"),
    ):
        resp = await client.get(f"{API}/does-not-exist")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_run_returns_run(client):
    with patch(
        "app.routers.pipeline.pipeline_runs_repo.get_or_404",
        new_callable=AsyncMock, return_value=fake_run(),
    ):
        resp = await client.get(f"{API}/run-001")
    assert resp.status_code == 200
    assert resp.json()["id"] == "run-001"
