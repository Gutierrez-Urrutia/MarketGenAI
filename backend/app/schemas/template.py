"""Pydantic schemas for the Templates module."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


class TemplateType(str, Enum):
    book_concept = "book_concept"
    chapter      = "chapter"
    proposal     = "proposal"
    social_post  = "social_post"
    one_pager    = "one_pager"


class TemplateCreate(BaseModel):
    name:        str = Field(..., min_length=2, max_length=200)
    type:        TemplateType
    description: Optional[str] = None
    content:     str           # The template body (may contain {placeholders})
    variables:   List[str] = []   # e.g. ["client_name", "product"]
    isPublic:    bool = False


class TemplateUpdate(BaseModel):
    name:        Optional[str] = Field(None, min_length=2, max_length=200)
    description: Optional[str] = None
    content:     Optional[str] = None
    variables:   Optional[List[str]] = None
    isPublic:    Optional[bool] = None


class TemplateOut(BaseModel):
    id:          str
    name:        str
    type:        str
    description: Optional[str] = None
    content:     str
    variables:   List[str] = []
    isPublic:    bool = False
    userId:      str
    usageCount:  int
    createdAt:   Optional[datetime] = None
    updatedAt:   Optional[datetime] = None

    class Config:
        from_attributes = True


class TemplateListResponse(BaseModel):
    items: List[TemplateOut]
    total: int


class ApplyTemplateRequest(BaseModel):
    variables: Dict[str, Any] = {}
