"""
Celery tasks for marketing asset generation.

Tasks:
  task_generate_one_pager     — PDF/HTML one-pager from book summary
  task_generate_whitepaper    — Full whitepaper PDF from book chapters
  task_generate_social_posts  — Social media posts (LinkedIn/Twitter/Facebook)
  task_generate_infographic   — Infographic JSON data structure
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from io import BytesIO
from typing import Any, Dict, List, Optional
from xml.sax.saxutils import escape

from bs4 import BeautifulSoup
from celery import Task
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    HRFlowable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.workers.celery_app import celery_app
from app.config import settings
from app.services import book_ai_service, deepseek_service
from app.services.firestore_service import assets_repo, jobs_repo
from app.services.storage_service import storage_service
from app.rendering.brand_styles import (
    BRAND_BORDER,
    BRAND_MUTED,
    BRAND_PRIMARY_INDIGO,
    content_base_styles,
)
from app.rendering.html_flowables import html_to_flowables, inline_markup
from app.rendering.infographic import build_infographic_pdf

logger = logging.getLogger(__name__)


def _run(coro):
    """Run an async coroutine from a sync Celery task."""
    return asyncio.get_event_loop().run_until_complete(coro)


_CHAPTER_HEADING_RE = re.compile(r"^(?:chapter|cap[ií]tulo|capitulo)\s*\d+", re.IGNORECASE)


def _strip_duplicate_chapter_heading(content: str, title: str) -> str:
    """Remove a leading h1/h2/h3 if the LLM already baked in its own
    'Chapter N: ...' or repeated the chapter title — avoids a duplicate
    heading on top of the one the PDF template adds explicitly."""
    if not content:
        return content
    soup = BeautifulSoup(content, "html.parser")
    first = next((el for el in soup.contents if getattr(el, "name", None)), None)
    if first and first.name in ("h1", "h2", "h3"):
        text = first.get_text(strip=True)
        title_norm = (title or "").strip().lower()
        if _CHAPTER_HEADING_RE.match(text) or (title_norm and text.lower().startswith(title_norm)):
            first.decompose()
    return str(soup)


# ── Whitepaper PDF (ReportLab — no native system libraries required) ─────────

def _inline_markup(tag) -> str:
    return inline_markup(tag)


def _whitepaper_styles():
    return content_base_styles()


def _chapter_flowables(content_html: str, styles) -> list:
    return html_to_flowables(content_html, styles)


def _whitepaper_page_decoration(canvas_obj, _doc_template):
    canvas_obj.saveState()
    canvas_obj.setStrokeColor(colors.HexColor(BRAND_BORDER))
    canvas_obj.setLineWidth(0.5)
    canvas_obj.line(54, 40, LETTER[0] - 54, 40)
    canvas_obj.setFont("Helvetica", 8)
    canvas_obj.setFillColor(colors.HexColor(BRAND_MUTED))
    canvas_obj.drawString(54, 28, "NoonDalton AI Marketing Suite")
    canvas_obj.drawRightString(LETTER[0] - 54, 28, f"Page {canvas_obj.getPageNumber()}")
    canvas_obj.restoreState()


def _build_whitepaper_pdf(book: Dict[str, Any], chapters: List[Dict[str, Any]]) -> bytes:
    styles = _whitepaper_styles()

    story = [
        Spacer(1, 200),
        Paragraph(escape(book.get("title", "")), styles["coverTitle"]),
        Paragraph(escape(book.get("description", "")), styles["coverSubtitle"]),
        PageBreak(),
    ]

    for i, ch in enumerate(chapters):
        if i > 0:
            story.append(PageBreak())
        content = _strip_duplicate_chapter_heading(ch.get("content", ""), ch.get("title", ""))
        story.append(Paragraph(escape(f"{i + 1}. {ch.get('title', '')}"), styles["chapterTitle"]))
        story.append(HRFlowable(width="100%", thickness=1.4, color=colors.HexColor(BRAND_PRIMARY_INDIGO), spaceAfter=12, hAlign="LEFT"))
        story.extend(_chapter_flowables(content, styles))

    buffer = BytesIO()
    pdf = SimpleDocTemplate(
        buffer,
        pagesize=LETTER,
        leftMargin=56,
        rightMargin=56,
        topMargin=50,
        bottomMargin=60,
    )
    pdf.build(story, onFirstPage=_whitepaper_page_decoration, onLaterPages=_whitepaper_page_decoration)
    return buffer.getvalue()


# ── One-Pager ─────────────────────────────────────────────────────────────────

def _build_one_pager_pdf(html_content: str) -> bytes:
    """Render the LLM-generated one-pager copy to a single-flow PDF using
    ReportLab (same corporate palette as _whitepaper_styles). No native
    system libraries required, unlike WeasyPrint, so this also works on
    Vercel serverless."""
    styles = _whitepaper_styles()
    indigo = colors.HexColor(BRAND_PRIMARY_INDIGO)

    soup = BeautifulSoup(html_content, "html.parser")
    cta_tag = soup.find(class_="cta")
    cta_text = _inline_markup(cta_tag) if cta_tag else None
    if cta_tag:
        cta_tag.decompose()

    story = _chapter_flowables(str(soup), styles)

    if cta_text:
        cta_style = ParagraphStyle(
            "OnePagerCta", parent=styles["body"], textColor=colors.white,
            alignment=1, fontName="Helvetica-Bold", spaceAfter=0,
        )
        # No native border-radius in ReportLab — a solid-color Table cell is
        # the closest equivalent, same cosmetic trade-off already accepted
        # for the whitepaper migration (square corners instead of rounded).
        cta_table = Table([[Paragraph(cta_text, cta_style)]], colWidths=[240])
        cta_table.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, -1), indigo),
            ("TOPPADDING",    (0, 0), (-1, -1), 10),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
            ("LEFTPADDING",   (0, 0), (-1, -1), 18),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 18),
            ("ALIGN",         (0, 0), (-1, -1), "CENTER"),
        ]))
        story.append(Spacer(1, 12))
        story.append(cta_table)

    buffer = BytesIO()
    pdf = SimpleDocTemplate(
        buffer,
        pagesize=LETTER,
        leftMargin=56,
        rightMargin=56,
        topMargin=50,
        bottomMargin=60,
    )
    pdf.build(story, onFirstPage=_whitepaper_page_decoration, onLaterPages=_whitepaper_page_decoration)
    return buffer.getvalue()


async def generate_one_pager_now(
    job_id:   str,
    asset_id: str,
    book:     Dict[str, Any],
    options:  Dict[str, Any],
) -> str:
    """Generate a one-pager PDF for the book. Shared by the Celery task and
    the sync fallback used when Celery/Redis is unavailable."""
    await jobs_repo.update_progress(job_id, 20, "processing")
    await assets_repo.update(asset_id, {"status": "generating"})

    # Use DeepSeek to write the one-pager copy
    prompt = (
        f"Write a professional one-pager for the following book:\n"
        f"Title: {book['title']}\n"
        f"Description: {book.get('description', '')}\n"
        f"Target audience: {book.get('targetAudience', '')}\n"
        f"Language: {options.get('language', 'es')}\n"
        f"Style: {options.get('style', 'professional')}\n\n"
        "Include: headline, problem statement, solution, key benefits (3-4 bullets), "
        "and a call to action. Wrap the call-to-action text in its own "
        '<p class="cta">...</p> paragraph so it can be styled distinctly from '
        "the rest of the copy. Return as clean HTML (no <html>/<body> wrapper, "
        "just inner content)."
    )
    variation_instruction = options.get("variationInstruction")
    if variation_instruction:
        prompt += f"\nAdditional variation instruction:\n{variation_instruction}\n"

    extra_kwargs = {}
    temperature = options.get("temperature")
    if temperature is not None:
        extra_kwargs["temperature"] = temperature

    html_content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You are an expert marketing copywriter specializing in concise, persuasive one-page sales collateral. Return clean HTML only.",
        timeout=settings.llm_long_timeout_seconds,
        **extra_kwargs,
    )
    html_content = book_ai_service._clean_fenced_text(html_content)

    await jobs_repo.update_progress(job_id, 60, "processing")

    # TODO: honor GenerateOnePagerRequest.maxPages (schemas/asset.py:30) here
    # — currently ignored, same as it was with the WeasyPrint implementation.
    pdf_bytes = _build_one_pager_pdf(html_content)

    # Upload to Supabase Storage
    path = storage_service.asset_path(asset_id, "one-pager.pdf")
    await storage_service.upload_bytes(pdf_bytes, path, "application/pdf")
    url = await storage_service.get_signed_url(path, expires_in_seconds=86400 * 7)

    await assets_repo.update(asset_id, {
        "status":      "ready",
        "content":     html_content,
        "storagePath": path,
        "downloadUrl": url,
        "mimeType":    "application/pdf",
    })
    await jobs_repo.complete_job(job_id, {"assetId": asset_id, "url": url})
    logger.info("one_pager done: job=%s asset=%s", job_id, asset_id)
    return url


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10, queue="llm")
def task_generate_one_pager(
    self: Task,
    job_id:   str,
    asset_id: str,
    book:     Dict[str, Any],
    options:  Dict[str, Any],
):
    """Generate a one-pager PDF document for the book."""
    try:
        _run(generate_one_pager_now(job_id, asset_id, book, options))
    except Exception as exc:
        logger.exception("one_pager failed: job=%s", job_id)
        _run(assets_repo.update(asset_id, {"status": "error"}))
        _run(jobs_repo.fail_job(job_id, str(exc)))
        raise self.retry(exc=exc)


# ── Whitepaper ────────────────────────────────────────────────────────────────

def _build_whitepaper_preview(book: Dict[str, Any], chapters: List[Dict[str, Any]]) -> str:
    """Short HTML preview for the asset card — not the full document (the
    full whitepaper is the downloadable PDF). Title + description + the
    first 2-3 paragraphs of the first chapter, enough for context."""
    parts = [f"<h1>{escape(book.get('title', ''))}</h1>"]
    if book.get("description"):
        parts.append(f"<p><strong>{escape(book['description'])}</strong></p>")

    first_chapter = chapters[0] if chapters else None
    if first_chapter and first_chapter.get("content"):
        soup = BeautifulSoup(first_chapter["content"], "html.parser")
        for p in soup.find_all("p")[:3]:
            parts.append(str(p))

    return "\n".join(parts)


async def generate_whitepaper_now(
    job_id:   str,
    asset_id: str,
    book:     Dict[str, Any],
    chapters: List[Dict[str, Any]],
    options:  Dict[str, Any],
) -> None:
    """Compile all chapter content into a whitepaper PDF. Shared by the Celery
    task and the sync fallback used when Celery/Redis is unavailable."""
    await jobs_repo.update_progress(job_id, 10, "processing")
    await assets_repo.update(asset_id, {"status": "generating"})

    n = len(chapters)
    force_regenerate = options.get("forceRegenerate", False)

    for i, ch in enumerate(chapters):
        if force_regenerate or not ch.get("content"):
            ch["content"] = await book_ai_service.generate_chapter_content(
                book_title=book["title"],
                book_description=book.get("description", ""),
                chapter_title=ch["title"],
                chapter_description=ch.get("description", ""),
                content_type=options.get("style", "academic"),
                style=options.get("style", "academic"),
                variation_instruction=options.get("variationInstruction"),
                temperature=options.get("temperature"),
                language=options.get("language", "es"),
            )
        progress = int(10 + ((i + 1) / n) * 70)
        await jobs_repo.update_progress(job_id, progress, "processing")

    # Pure-Python rendering (ReportLab) — no native GTK/Pango libraries
    # required, unlike WeasyPrint, so this also works on Vercel serverless.
    pdf_bytes = _build_whitepaper_pdf(book, chapters)

    path = storage_service.asset_path(asset_id, "whitepaper.pdf")
    await storage_service.upload_bytes(pdf_bytes, path, "application/pdf")
    url = await storage_service.get_signed_url(path, expires_in_seconds=86400 * 7)

    await assets_repo.update(asset_id, {
        "status":      "ready",
        "content":     _build_whitepaper_preview(book, chapters),
        "storagePath": path,
        "downloadUrl": url,
        "mimeType":    "application/pdf",
    })
    await jobs_repo.complete_job(job_id, {"assetId": asset_id, "url": url})
    logger.info("whitepaper done: job=%s asset=%s", job_id, asset_id)


@celery_app.task(bind=True, max_retries=2, default_retry_delay=30, queue="llm")
def task_generate_whitepaper(
    self:     Task,
    job_id:   str,
    asset_id: str,
    book:     Dict[str, Any],
    chapters: List[Dict[str, Any]],
    options:  Dict[str, Any],
):
    try:
        _run(generate_whitepaper_now(job_id, asset_id, book, chapters, options))
    except Exception as exc:
        logger.exception("whitepaper failed: job=%s", job_id)
        _run(assets_repo.update(asset_id, {"status": "error"}))
        _run(jobs_repo.fail_job(job_id, str(exc)))
        raise self.retry(exc=exc)


# ── Social Posts ──────────────────────────────────────────────────────────────
async def generate_social_posts_now(
    job_id:   str,
    asset_id: str,
    book:     Dict[str, Any],
    chapter:  Optional[Dict[str, Any]],
    options:  Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Generate platform-specific social media posts. Shared by the Celery
    task and the sync fallback used when Celery/Redis is unavailable."""
    await jobs_repo.update_progress(job_id, 20, "processing")
    await assets_repo.update(asset_id, {"status": "generating"})

    content_ref = (
        chapter["content"] if chapter and chapter.get("content")
        else book.get("description", book["title"])
    )

    posts = await book_ai_service.generate_social_posts(
        book_title=book["title"],
        content_summary=content_ref,
        platforms=options.get("platforms", ["linkedin", "twitter", "facebook"]),
        tone=options.get("tone", "professional"),
        variation_instruction=options.get("variationInstruction"),
        temperature=options.get("temperature"),
        language=options.get("language", "es"),
    )

    await assets_repo.update(asset_id, {
        "status":  "ready",
        "content": json.dumps(posts, ensure_ascii=False),
        "mimeType": "application/json",
    })
    await jobs_repo.complete_job(job_id, {"assetId": asset_id, "posts": posts})
    logger.info("social_posts done: job=%s asset=%s", job_id, asset_id)
    return posts


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10, queue="llm")
def task_generate_social_posts(
    self:    Task,
    job_id:  str,
    asset_id: str,
    book:    Dict[str, Any],
    chapter: Optional[Dict[str, Any]],
    options: Dict[str, Any],
):
    """Generate platform-specific social media posts."""
    try:
        _run(generate_social_posts_now(job_id, asset_id, book, chapter, options))
    except Exception as exc:
        logger.exception("social_posts failed: job=%s", job_id)
        _run(assets_repo.update(asset_id, {"status": "error"}))
        _run(jobs_repo.fail_job(job_id, str(exc)))
        raise self.retry(exc=exc)


# ── Infographic ───────────────────────────────────────────────────────────────
async def generate_infographic_now(
    job_id:   str,
    asset_id: str,
    book:     Dict[str, Any],
    options:  Dict[str, Any],
) -> Dict[str, Any]:
    """
    Generate a structured JSON data payload for an infographic. Shared by the
    Celery task and the sync fallback used when Celery/Redis is unavailable.
    The frontend renders this with a canvas or SVG library.
    """
    await jobs_repo.update_progress(job_id, 20, "processing")
    await assets_repo.update(asset_id, {"status": "generating"})

    prompt = (
        f"Create a structured JSON data payload for an infographic about:\n"
        f"Title: {book['title']}\n"
        f"Description: {book.get('description', '')}\n\n"
        f"Language: {options.get('language', 'es')}. Every user-facing JSON value must be in this language.\n\n"
        "The JSON must have this structure:\n"
        '{"title": "...", "subtitle": "...", "sections": ['
        '{"heading": "...", "stat": "...", "description": "..."}], '
        '"keyPoints": ["...", ...], "callToAction": "..."}\n'
        "Return only the JSON, no markdown."
    )
    variation_instruction = options.get("variationInstruction")
    if variation_instruction:
        prompt += f"\nAdditional variation instruction:\n{variation_instruction}\n"

    extra_kwargs = {}
    temperature = options.get("temperature")
    if temperature is not None:
        extra_kwargs["temperature"] = temperature

    raw = await deepseek_service.generate_text(
        prompt,
        system_prompt="You are an expert data storyteller who converts book content into structured infographic data. Return strict JSON only, no markdown, no commentary.",
        timeout=settings.llm_long_timeout_seconds,
        **extra_kwargs,
    )
    infographic_data = book_ai_service._safe_json(raw)

    content_str = json.dumps(infographic_data, ensure_ascii=False)
    pdf_bytes = build_infographic_pdf(
        infographic_data,
        {
            "book_title": book.get("title", ""),
            "description": book.get("description", ""),
            "language": options.get("language", "es"),
        },
    )
    path = storage_service.asset_path(asset_id, "infographic.pdf")
    await storage_service.upload_bytes(pdf_bytes, path, "application/pdf")
    url = await storage_service.get_signed_url(path, expires_in_seconds=86400 * 7)

    await assets_repo.update(asset_id, {
        "status":      "ready",
        "content":     content_str,
        "storagePath": path,
        "downloadUrl": url,
        "mimeType":    "application/pdf",
    })
    await jobs_repo.complete_job(job_id, {"assetId": asset_id, "data": infographic_data})
    logger.info("infographic done: job=%s asset=%s", job_id, asset_id)
    return infographic_data


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10, queue="llm")
def task_generate_infographic(
    self:    Task,
    job_id:  str,
    asset_id: str,
    book:    Dict[str, Any],
    options: Dict[str, Any],
):
    """Generate a structured JSON data payload for an infographic."""
    try:
        _run(generate_infographic_now(job_id, asset_id, book, options))
    except Exception as exc:
        logger.exception("infographic failed: job=%s", job_id)
        _run(assets_repo.update(asset_id, {"status": "error"}))
        _run(jobs_repo.fail_job(job_id, str(exc)))
        raise self.retry(exc=exc)
