"""Celery tasks for the prospecting pipeline — Agente 1 only (Fase 2).

No periodic/beat task here. This task is only ever invoked explicitly, by
routers/pipeline.py's `POST /pipeline/runs`. Scheduling (when/how often a
PipelineConfig gets scanned automatically) is Fase 5-6 and is not decided
yet — see job_scout_service module docstring and
analisis-worker-serverless.md.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict

from celery import Task

from app.services import job_scout_service
from app.schemas.pipeline import PipelineRunStatus
from app.services.firestore_service import pipeline_run_locks_repo, pipeline_runs_repo
from app.workers.celery_app import celery_app

logger = logging.getLogger(__name__)


def _run(coro):
    """Run an async coroutine from a sync Celery task."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


async def run_job_scout_now(run_id: str, pipeline_config: Dict[str, Any]) -> Dict[str, Any]:
    """Execute the Agente 1 scan synchronously (used by both inline fallback and Celery task)."""
    try:
        # The request that queued this task may have given up waiting for the
        # broker and already run the scan inline (routers/pipeline._enqueue_scan).
        # If this message arrives late, do not scan the same run twice.
        run = await pipeline_runs_repo.get(run_id)
        if not run or run.get("status") != PipelineRunStatus.RUNNING.value:
            logger.warning("run_job_scout_now: run %s is not running any more; skipping.", run_id)
            return {}
        result = await job_scout_service.scan_all_sources(pipeline_config, run_id)
        await job_scout_service.finalize_run(run_id, result)
        return result
    except Exception as exc:
        logger.exception("run_job_scout_now failed for run %s", run_id)
        await job_scout_service.fail_run(run_id, str(exc))
        raise
    finally:
        await pipeline_run_locks_repo.release(pipeline_config["id"], run_id)


@celery_app.task(bind=True, max_retries=2, default_retry_delay=10, queue="llm")
def task_run_job_scout(self: Task, run_id: str, pipeline_config: Dict[str, Any]):
    """Agente 1 only — scans every enabled source of one PipelineConfig and
    finalizes its PipelineRun doc via background Celery worker. Agente 2/3 and
    the orchestrator that would chain them are Fase 3/4/6, not called from here."""
    try:
        return _run(run_job_scout_now(run_id, pipeline_config))
    except Exception as exc:
        logger.exception("task_run_job_scout failed for run %s", run_id)
        return None

