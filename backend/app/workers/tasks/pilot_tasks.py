"""
Pilot Celery task for DeepSeek text generation.
Demonstrates asynchronous execution, error handling, and automated retries.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from celery import Task

from app.config import settings
from app.services import deepseek_service
from app.workers.celery_app import celery_app

logger = logging.getLogger("marketgen.celery.pilot")


@celery_app.task(bind=True, max_retries=3, default_retry_delay=5)
def task_pilot_deepseek(
    self: Task,
    prompt: str,
    system_prompt: str = "You are a helpful assistant.",
    temperature: float = 0.7,
) -> Dict[str, Any]:
    """
    Executes a test/pilot prompt against DeepSeek via a background Celery worker.
    """
    logger.info(
        "🚀 [Celery] Iniciando tarea piloto %s (Intento %d/%d)...",
        self.request.id,
        self.request.retries + 1,
        self.max_retries + 1,
    )
    try:
        content = deepseek_service._generate_text_sync(
            prompt=prompt,
            system_prompt=system_prompt,
            temperature=temperature,
            timeout=settings.llm_default_timeout_seconds,
        )
        logger.info("✅ [Celery] Tarea piloto %s finalizada exitosamente.", self.request.id)
        return {
            "task_id": self.request.id,
            "prompt": prompt,
            "result": content,
            "model": settings.deepseek_model,
            "status": "completed",
        }
    except Exception as exc:
        logger.error(
            "❌ [Celery] Error en tarea piloto %s: %s",
            self.request.id,
            exc,
            exc_info=True,
        )
        if self.request.retries < self.max_retries:
            logger.info("🔄 [Celery] Reintentando tarea %s en 5s...", self.request.id)
            raise self.retry(exc=exc)
        raise exc
