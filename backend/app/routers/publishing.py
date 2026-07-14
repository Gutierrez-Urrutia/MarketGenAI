"""
Publishing router — publish books to external channels and translate content.

Endpoints:
  POST   /books/{book_id}/publish     — publish to one or more channels
  POST   /books/{book_id}/translate   — translate all chapters to target language
  GET    /books/{book_id}/publish/status — get publish status
"""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.job import JobAccepted
from app.services.firestore_service import books_repo, jobs_repo
from app.workers.tasks.content_tasks import task_publish_book, task_translate_book

router = APIRouter(prefix="/books", tags=["Publishing"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class PublishChannel(str):
    """Supported publishing channels."""
    MEDIUM        = "medium"
    LINKEDIN      = "linkedin"
    GHOST         = "ghost"
    WORDPRESS     = "wordpress"
    PDF_EXPORT    = "pdf_export"
    EPUB_EXPORT   = "epub_export"


class PublishRequest(BaseModel):
    channels: List[str] = Field(
        ...,
        min_items=1,
        description="Publishing targets: medium, linkedin, ghost, wordpress, pdf_export, epub_export",
        examples=[["pdf_export", "linkedin"]],
    )
    chapterIds: Optional[List[str]] = Field(
        None,
        description="Subset of chapter IDs to publish. Defaults to all chapters.",
    )
    includeCovers: bool = Field(True, description="Add cover page to exports.")
    watermark: Optional[str] = Field(None, description="Optional watermark text.")
    publishMode: str = Field(
        "now",
        description="Publish timing mode: 'now' or 'scheduled'.",
        examples=["scheduled"],
    )
    scheduledAt: Optional[datetime] = Field(
        None,
        description="ISO date-time for scheduled social publishing.",
    )


class TranslateRequest(BaseModel):
    targetLanguage: str = Field(
        ...,
        description="BCP-47 language code or plain name, e.g. 'es', 'French', 'pt-BR'.",
        examples=["Spanish"],
    )
    chapterIds: Optional[List[str]] = Field(
        None,
        description="Subset of chapter IDs to translate. Defaults to all chapters.",
    )
    adaptCulturalNuances: bool = Field(
        True,
        description="Adapt idioms and cultural references (true) vs. literal translation (false).",
    )
    saveAs: str = Field(
        "new_version",
        description="How to store the translation: 'new_version' appends a copy, 'overwrite' replaces content.",
    )


class PublishStatusOut(BaseModel):
    bookId: str
    channels: List[dict]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _assert_owner(book: dict, user_id: str) -> None:
    if book.get("userId") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")


async def _get_book_for_user(book_id: str, user_id: str) -> dict:
    book = await books_repo.get(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found.")
    _assert_owner(book, user_id)
    return book


# ── Publish ───────────────────────────────────────────────────────────────────

@router.post("/{book_id}/publish", response_model=JobAccepted, status_code=202)
async def publish_book(
    book_id: str,
    body:    PublishRequest,
    user:    CurrentUser = Depends(get_current_user),
):
    """
    Schedule an async publishing job for one or more channels.

    The job generates the final output (PDF/EPUB or social post) and, if the
    channel has credentials configured in Settings, pushes directly to it.
    Returns a job_id that the client can poll via GET /jobs/{job_id}.
    """
    book = await _get_book_for_user(book_id, user.sub)

    # Validate book has content to publish
    if book.get("status") not in ("generated", "published"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Book must have generated content before publishing. "
                   "Run content generation first.",
        )

    chapters = await books_repo.get_chapters(book_id)
    if body.chapterIds:
        chapters = [c for c in chapters if c["id"] in body.chapterIds]

    if not chapters:
        raise HTTPException(status_code=422, detail="No chapters available to publish.")

    if body.publishMode == "scheduled" and body.scheduledAt is None:
        raise HTTPException(status_code=422, detail="scheduledAt is required when publishMode is scheduled.")

    options = body.model_dump(mode="json")

    job = await jobs_repo.create_job(
        "book_publish",
        user.sub,
        {
            "bookId":    book_id,
            "channels":  options["channels"],
            "options":   options,
        },
    )

    task_publish_book.delay(job["id"], book, chapters, options)

    return JobAccepted(job_id=job["id"])


# ── Translate ─────────────────────────────────────────────────────────────────

@router.post("/{book_id}/translate", response_model=JobAccepted, status_code=202)
async def translate_book(
    book_id: str,
    body:    TranslateRequest,
    user:    CurrentUser = Depends(get_current_user),
):
    """
    Schedule async translation of all (or selected) chapters to a target language.

    - saveAs='new_version'  → creates new chapter documents with a language suffix
    - saveAs='overwrite'    → replaces existing chapter content in-place
    """
    book = await _get_book_for_user(book_id, user.sub)

    chapters = await books_repo.get_chapters(book_id)
    if body.chapterIds:
        chapters = [c for c in chapters if c["id"] in body.chapterIds]

    if not chapters:
        raise HTTPException(status_code=422, detail="No chapters available to translate.")

    job = await jobs_repo.create_job(
        "book_translation",
        user.sub,
        {
            "bookId":         book_id,
            "targetLanguage": body.targetLanguage,
        },
    )

    task_translate_book.delay(job["id"], book, chapters, body.model_dump())

    return JobAccepted(job_id=job["id"])


# ── Publish status ────────────────────────────────────────────────────────────

@router.get("/{book_id}/publish/status", response_model=PublishStatusOut)
async def get_publish_status(
    book_id: str,
    user:    CurrentUser = Depends(get_current_user),
):
    """
    Returns the latest publish attempt status per channel for this book.
    Channel records are stored in book.publishHistory.
    """
    book = await _get_book_for_user(book_id, user.sub)
    history = book.get("publishHistory", [])
    return PublishStatusOut(bookId=book_id, channels=history)
