"""Pydantic schemas for the Campaigns module."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

class CampaignChannel(str, Enum):
    linkedin = "linkedin"
    facebook = "facebook"
    twitter_x = "twitter_x"
    substack = "substack"
    email_outreach = "email_outreach"


class CampaignStatus(str, Enum):
    draft = "draft"
    active = "active"
    paused = "paused"
    completed = "completed"


class CampaignCreate(BaseModel):
    """Fields accepted when creating a campaign."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=200)
    audience: str = ""
    objective: str = ""
    context: str = ""
    channels: list[CampaignChannel] = Field(
        default_factory=lambda: [CampaignChannel.linkedin]
    )
    status: CampaignStatus = CampaignStatus.draft
    briefData: Optional[dict[str, Any]] = None


class CampaignUpdate(BaseModel):
    """Partial update - only the provided fields are modified."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(None, min_length=1, max_length=200)
    audience: Optional[str] = None
    objective: Optional[str] = None
    context: Optional[str] = None
    channels: Optional[list[CampaignChannel]] = None
    status: Optional[CampaignStatus] = None
    briefData: Optional[dict[str, Any]] = None


class CampaignOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    audience: str = ""
    objective: str = ""
    context: str = ""
    channels: list[CampaignChannel] = Field(default_factory=list)
    status: CampaignStatus
    briefData: Optional[dict[str, Any]] = None
    aiGeneration: Optional[dict[str, Any]] = None
    userId: str
    createdAt: datetime
    updatedAt: datetime
