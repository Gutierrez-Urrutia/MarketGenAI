"""Pydantic schemas for asynchronous Celery tasks."""
from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, ConfigDict, Field


class PilotTaskRequest(BaseModel):
    """Payload to enqueue a pilot DeepSeek background task."""
    model_config = ConfigDict(extra="allow")

    prompt: str = Field(..., min_length=1, description="Texto o prompt de entrada")
    system_prompt: Optional[str] = Field(
        "You are a helpful assistant.",
        description="Instrucción de sistema para el modelo",
    )
    temperature: Optional[float] = Field(
        0.7,
        ge=0.0,
        le=2.0,
        description="Temperatura de muestreo",
    )


class TaskEnqueueResponse(BaseModel):
    """Immediate response returned with HTTP 202 upon enqueueing."""
    task_id: str = Field(..., description="Identificador único de la tarea en Celery")
    status: str = Field("PENDING", description="Estado inicial de la tarea")
    message: str = Field(
        "Task enqueued successfully",
        description="Mensaje informativo para el cliente",
    )


class TaskStatusResponse(BaseModel):
    """Response returned when querying the current status of a background task."""
    task_id: str
    status: str = Field(..., description="PENDING | STARTED | SUCCESS | FAILURE | RETRY")
    ready: bool = Field(..., description="Indica si la tarea ya concluyó su ejecución")
    successful: Optional[bool] = Field(
        None,
        description="True si finalizó con éxito, False si falló, None si sigue en progreso",
    )
    result: Optional[Any] = Field(None, description="Datos retornados si la tarea fue exitosa")
    error: Optional[str] = Field(None, description="Mensaje de error si la tarea falló")
