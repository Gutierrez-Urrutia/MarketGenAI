"""Pydantic schemas for the Proposals module."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import List, Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class ProposalStatus(str, Enum):
    draft      = "draft"
    generated  = "generated"
    sent       = "sent"
    accepted   = "accepted"
    rejected   = "rejected"


class ProposalCreate(BaseModel):
    """Fields accepted when creating a proposal.

    Extra fields sent by the dashboard's AI-assisted flow (pricing rows,
    structured content, tags, etc.) are preserved as-is.
    """
    model_config = ConfigDict(extra="allow")

    title:       str = Field(..., min_length=1, max_length=200)
    clientName:  Optional[str] = Field(None, max_length=200)
    description: Optional[str] = None
    content:     Optional[str] = None
    bookId:      Optional[str] = None
    proposal_status: str = "Generada"


class ProposalUpdate(BaseModel):
    """Partial update — only the provided fields are modified."""
    model_config = ConfigDict(extra="allow")

    title:       Optional[str] = Field(None, min_length=1, max_length=200)
    clientName:  Optional[str] = None
    description: Optional[str] = None
    status:      Optional[str] = None
    content:     Optional[str] = None   # HTML/markdown body


class ProposalLineItem(BaseModel):
    """A priced service included in a generated proposal."""
    model_config = ConfigDict(extra="allow")

    name:        Optional[str] = Field(None, validation_alias=AliasChoices("name", "service"))
    description: Optional[str] = None
    qty:         Optional[float] = Field(None, validation_alias=AliasChoices("qty", "quantity"))
    unitPrice:   Optional[float] = Field(None, validation_alias=AliasChoices("unitPrice", "unit_price"))


class GenerateProposalRequest(BaseModel):
    """Ask the LLM to draft/redraft the proposal body."""
    model_config = ConfigDict(extra="allow")

    title:               Optional[str] = None
    clientName:          Optional[str] = None
    description:         Optional[str] = None
    detailedDescription: Optional[str] = None
    teamSizing:          Optional[str] = None
    lineItems:           Optional[List[ProposalLineItem]] = None
    totalAmount:         Optional[float] = None
    length:              Literal["brief", "standard", "extended"] = "standard"
    style:               str = "professional"
    language:            str = "es"
    customPrompt:        Optional[str] = None


class ProposalVersionCreate(BaseModel):
    """Save a new version/snapshot of the proposal content."""
    model_config = ConfigDict(extra="allow")

    title:   Optional[str] = None
    content: Optional[str] = None
    label:   Optional[str] = None


class SendToCrmRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    provider: Optional[str] = None


class ExportProposalRequest(BaseModel):
    format: str = Field("pdf", pattern="^(pdf|docx)$")


class ProposalOut(BaseModel):
    """Response shape. `extra='allow'` preserves ad-hoc fields (filePath,
    crmSync, versions, totalAmount, etc.) already stored on existing
    proposal documents."""
    model_config = ConfigDict(extra="allow", from_attributes=True)

    id:          str
    title:       Optional[str] = None
    clientName:  Optional[str] = None
    description: Optional[str] = None
    status:      Optional[str] = None
    proposal_status: Optional[str] = None
    content:     Optional[str] = None
    userId:      Optional[str] = None
    bookId:      Optional[str] = None
    downloadUrl: Optional[str] = None
    createdAt:   Optional[datetime] = None
    updatedAt:   Optional[datetime] = None


class ProposalListResponse(BaseModel):
    items: List[ProposalOut]
    total: int
