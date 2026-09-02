"""
Pydantic schemas — Book Concepts y Chapters.
Usado por: backend/app/routers/books.py
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


# ── Enums ──────────────────────────────────────────────────────────────────────

class BookStatus(str, Enum):
    draft     = "draft"
    outlined  = "outlined"
    generated = "generated"
    published = "published"


class ChapterStatus(str, Enum):
    pending   = "pending"
    generated = "generated"
    edited    = "edited"
    draft     = "draft"


class ContentType(str, Enum):
    full  = "full"
    long  = "long"
    short = "short"


class WritingStyle(str, Enum):
    professional   = "professional"
    conversational = "conversational"
    academic       = "academic"
    creative       = "creative"
    technical      = "technical"
    persuasive     = "persuasive"


# ── Chapter schemas ────────────────────────────────────────────────────────────

class ChapterBase(BaseModel):
    title:       str            = Field(..., max_length=255)
    description: Optional[str] = None


class ChapterCreate(ChapterBase):
    pass


class ChapterUpdate(BaseModel):
    title:       Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None


class ChapterOut(ChapterBase):
    id:               str
    book_id:          str  = Field(alias="bookId")
    order_index:      int  = Field(alias="orderIndex")
    status:           ChapterStatus
    word_count:       int  = Field(0, alias="wordCount")
    content_available: bool = Field(False, alias="contentAvailable")
    created_at:       datetime = Field(alias="createdAt")
    updated_at:       datetime = Field(alias="updatedAt")

    model_config = {"populate_by_name": True}


class ChapterReorder(BaseModel):
    chapter_ids: List[str] = Field(..., alias="chapterIds", min_length=1)

    model_config = {"populate_by_name": True}


class ChapterContentSave(BaseModel):
    content: str = Field(..., max_length=100_000)
    format:  str = Field("html", pattern="^(html|markdown)$")


# ── Book schemas ───────────────────────────────────────────────────────────────

class BookCreate(BaseModel):
    title:       str       = Field(..., max_length=255)
    description: str       = Field(..., min_length=10)
    keywords:    List[str] = Field(default_factory=list)

    model_config = {
        "json_schema_extra": {
            "example": {
                "title":       "AI in Modern Marketing",
                "description": "Guía completa sobre cómo los equipos de marketing pueden usar IA.",
                "keywords":    ["AI", "marketing", "automatización"],
            }
        }
    }


class BookUpdate(BaseModel):
    title:       Optional[str]       = Field(None, max_length=255)
    description: Optional[str]       = None
    keywords:    Optional[List[str]] = None
    status:      Optional[BookStatus] = None


class BookOut(BaseModel):
    id:          str
    title:       str
    description: str
    keywords:    List[str]
    status:      BookStatus
    user_id:     str           = Field(alias="userId")
    chapters:    List[ChapterOut] = []
    created_at:  datetime      = Field(alias="createdAt")
    updated_at:  datetime      = Field(alias="updatedAt")

    model_config = {"populate_by_name": True}


class BookListItem(BaseModel):
    id:            str
    title:         str
    status:        BookStatus
    chapter_count: int      = Field(0, alias="chapterCount")
    created_at:    datetime = Field(alias="createdAt")
    updated_at:    datetime = Field(alias="updatedAt")

    model_config = {"populate_by_name": True}


class BookListResponse(BaseModel):
    data:  List[BookListItem]
    total: int
    page:  int
    limit: int


# ── Generation request schemas ─────────────────────────────────────────────────

class GenerateChaptersRequest(BaseModel):
    chapter_count: int = Field(5, ge=1, le=15, alias="chapterCount")
    language: str = Field("en", max_length=5)
    sync: bool = False

    model_config = {"populate_by_name": True}


class GenerateContentRequest(BaseModel):
    content_type: ContentType  = Field(ContentType.long,         alias="contentType")
    style:        WritingStyle = Field(WritingStyle.professional, alias="style")
    language:     str          = Field("en", max_length=5)
    sync:         bool         = False

    model_config = {"populate_by_name": True}


class RefineContentRequest(BaseModel):
    instruction: str = Field(..., max_length=500)
    language: str = Field("en", max_length=5)
