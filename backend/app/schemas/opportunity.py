"""Pydantic schemas for the Opportunities module."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class OpportunityStage(str, Enum):
    detected = "Detected"
    researching = "Researching"
    contacted = "Contacted"
    replied = "Replied"
    in_conversation = "In Conversation"
    won = "Won"
    customer = "Customer"
    lost = "Lost"


class OpportunityCreate(BaseModel):
    """Fields accepted when creating an opportunity."""

    model_config = ConfigDict(extra="forbid")

    company: str = Field(..., min_length=1, max_length=200)
    job: str = Field(..., min_length=1, max_length=200)
    contact: str = ""
    role: str = ""
    stage: OpportunityStage = OpportunityStage.detected
    source: str = ""
    kw: list[str] = Field(default_factory=list)
    content: str = ""
    date: str = ""
    contactEmail: str = ""
    score: Optional[float] = Field(None, exclude=True)


class OpportunityUpdate(BaseModel):
    """Partial update - only the provided fields are modified."""

    model_config = ConfigDict(extra="forbid")

    company: Optional[str] = Field(None, min_length=1, max_length=200)
    job: Optional[str] = Field(None, min_length=1, max_length=200)
    contact: Optional[str] = None
    role: Optional[str] = None
    stage: Optional[OpportunityStage] = None
    source: Optional[str] = None
    kw: Optional[list[str]] = None
    content: Optional[str] = None
    date: Optional[str] = None
    contactEmail: Optional[str] = None
    score: Optional[float] = Field(None, exclude=True)


class OpportunityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    company: str
    job: str
    contact: str = ""
    role: str = ""
    stage: OpportunityStage = OpportunityStage.detected
    source: str = ""
    kw: list[str] = Field(default_factory=list)
    content: str = ""
    date: str = ""
    contactEmail: str = ""
    score: int
    userId: str
    createdAt: datetime
    updatedAt: datetime
