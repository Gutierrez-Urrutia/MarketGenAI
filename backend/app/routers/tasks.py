"""Tasks router — asynchronous task enqueueing and status polling."""
from __future__ import annotations

import logging
from celery.result import AsyncResult
from fastapi import APIRouter, HTTPException, status

from app.schemas.task import PilotTaskRequest, TaskEnqueueResponse, TaskStatusResponse
from app.workers.celery_app import celery_app
from app.workers.tasks.pilot_tasks import task_pilot_deepseek

logger = logging.getLogger("marketgen.tasks.router")

router = APIRouter(prefix="/tasks", tags=["Tasks"])


@router.post(
    "/pilot",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=TaskEnqueueResponse,
    summary="Encolar tarea piloto con DeepSeek en segundo plano",
)
async def enqueue_pilot_task(body: PilotTaskRequest):
    """
    Encola una tarea de generación en segundo plano vía Celery y responde de inmediato con HTTP 202.
    """
    try:
        celery_task = task_pilot_deepseek.delay(
            prompt=body.prompt,
            system_prompt=body.system_prompt or "You are a helpful assistant.",
            temperature=body.temperature if body.temperature is not None else 0.7,
        )
        logger.info("📥 [API] Tarea piloto encolada con ID: %s", celery_task.id)
        return TaskEnqueueResponse(
            task_id=str(celery_task.id),
            status="PENDING",
            message="Task enqueued successfully",
        )
    except Exception as exc:
        logger.error("❌ [API] Error al conectar con el broker Redis / Celery: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"No se pudo encolar la tarea en Redis: {exc}",
        )


@router.get(
    "/{task_id}",
    response_model=TaskStatusResponse,
    summary="Consultar estado y resultado de una tarea de Celery",
)
async def get_task_status(task_id: str):
    """
    Consulta el estado actual de una tarea asíncrona mediante AsyncResult.
    Estados posibles: PENDING, STARTED, SUCCESS, FAILURE, RETRY.
    """
    try:
        res = AsyncResult(task_id, app=celery_app)
        ready = res.ready()
        status_name = res.status
        successful = res.successful() if ready else None
        result_data = None
        error_msg = None

        if ready:
            if successful:
                result_data = res.result
            else:
                error_msg = str(res.result)

        return TaskStatusResponse(
            task_id=task_id,
            status=status_name,
            ready=ready,
            successful=successful,
            result=result_data,
            error=error_msg,
        )
    except Exception as exc:
        logger.error("❌ [API] Error al consultar el resultado de la tarea %s: %s", task_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error consultando el estado de la tarea: {exc}",
        )
