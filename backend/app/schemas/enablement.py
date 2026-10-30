"""Pydantic schemas for Sales Enablement (RF-VTA-08)."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

EnablementType = Literal["case_study", "comparison", "objection"]


class EnablementGenerateRequest(BaseModel):
    """Pedido de un borrador de material de apoyo.

    `topic` es el servicio (caso de éxito), lo que se compara (comparativa) o la
    objeción textual del cliente (respuesta a objeción).
    """
    type: EnablementType
    topic: str = Field(..., min_length=3, max_length=500)
    clientName: Optional[str] = Field(None, max_length=200)
    opportunityId: Optional[str] = None
    language: str = Field("es", max_length=10)
    instructions: Optional[str] = Field(None, max_length=1000)


class EnablementDraftUpdate(BaseModel):
    """Edición parcial del borrador."""
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    content: Optional[str] = Field(None, min_length=1, max_length=40000)


class EnablementSource(BaseModel):
    docId: str
    title: str


class EnablementDraftOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    type: EnablementType
    title: str
    topic: str
    clientName: str = ""
    opportunityId: Optional[str] = None
    language: str = "es"
    content: str
    sources: list[EnablementSource] = Field(default_factory=list)
    userId: str
    createdAt: datetime
    updatedAt: datetime
