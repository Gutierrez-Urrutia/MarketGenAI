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
from app.workers.celery_app import celery_app

logger = logging.getLogger(__name__)


def _run(coro):
    """Run an async coroutine from a sync Celery task."""
    return asyncio.get_event_loop().run_until_complete(coro)


@celery_app.task(bind=True, max_retries=2, default_retry_delay=10, queue="llm")
def task_run_job_scout(self: Task, run_id: str, pipeline_config: Dict[str, Any]):
    """Agente 1 only — scans every enabled source of one PipelineConfig and
    finalizes its PipelineRun doc. Agente 2/3 and the orchestrator that
    would chain them are Fase 3/4/6, not called from here."""
    try:
        result = _run(job_scout_service.scan_all_sources(pipeline_config, run_id))
        _run(job_scout_service.finalize_run(run_id, result))
    except Exception as exc:
        logger.exception("task_run_job_scout failed for run %s", run_id)
        _run(job_scout_service.fail_run(run_id, str(exc)))
