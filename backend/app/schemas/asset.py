"""Pydantic schemas for the Marketing Assets module."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional, List
from pydantic import BaseModel, Field


class AssetType(str, Enum):
    one_pager    = "one_pager"
    whitepaper   = "whitepaper"
    social_post  = "social_post"
    infographic  = "infographic"
    image        = "image"
    campaign_content = "campaign_content"


class AssetStatus(str, Enum):
    pending    = "pending"
    generating = "generating"
    ready      = "ready"
    error      = "error"


class GenerateOnePagerRequest(BaseModel):
    bookId:      str
    style:       str = "professional"
    language:    str = "es"
    maxPages:    int = Field(2, ge=1, le=5)
    variationInstruction: Optional[str] = None
    temperature: Optional[float] = None


class GenerateWhitepaperRequest(BaseModel):
    bookId:      str
    chapterIds:  Optional[List[str]] = None   # None = all chapters
    style:       str = "academic"
    language:    str = "es"
    forceRegenerate: bool = False
    variationInstruction: Optional[str] = None
    temperature: Optional[float] = None


class GenerateSocialPostsRequest(BaseModel):
    bookId:      str
    chapterId:   Optional[str] = None
    platforms:   List[str] = ["linkedin", "twitter", "facebook"]
    tone:        str = "professional"
    language:    str = "es"
    variationInstruction: Optional[str] = None
    temperature: Optional[float] = None


class GenerateInfographicRequest(BaseModel):
    bookId:      str
    chapterId:   Optional[str] = None
    style:       str = "modern"
    language:    str = "es"
    variationInstruction: Optional[str] = None
    temperature: Optional[float] = None


class AssetOut(BaseModel):
    id:          str
    type:        str
    bookId:      Optional[str] = None
    campaignId:  Optional[str] = None
    userId:      str
    status:      str
    title:       Optional[str] = None
    content:     Optional[str] = None    # HTML / JSON / markdown depending on type
    downloadUrl: Optional[str] = None
    mimeType:    Optional[str] = None
    createdAt:   Optional[datetime] = None
    updatedAt:   Optional[datetime] = None

    class Config:
        from_attributes = True


class AssetListResponse(BaseModel):
    items: List[AssetOut]
    total: int
