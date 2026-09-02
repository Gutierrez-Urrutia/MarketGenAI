"""Content analysis router - SEO scoring, AI-detection, plagiarism check."""
from __future__ import annotations

import json
import re
from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.config import settings
from app.dependencies.auth import CurrentUser, get_current_user
from app.services import deepseek_service

router = APIRouter(prefix="/analysis", tags=["Content Analysis"])


class ContentAnalysisRequest(BaseModel):
    content: str
    bookId: Optional[str] = None
    chapterId: Optional[str] = None
    language: str = "es"


def _safe_json(raw_content: str) -> Any:
    cleaned = re.sub(r"```(?:json)?\s*", "", raw_content or "").strip().rstrip("`").strip()
    return json.loads(cleaned)


async def _generate_analysis_json(prompt: str, *, system_prompt: str) -> Any:
    raw = await deepseek_service.generate_text(
        prompt,
        system_prompt=system_prompt,
        temperature=0.2,
        timeout=settings.llm_default_timeout_seconds,
    )
    return _safe_json(raw)


@router.post("/seo")
async def analyse_seo(
    body: ContentAnalysisRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """
    Analyse content for SEO quality.
    Returns: keyword density, readability score, suggested improvements, meta tags.
    """
    prompt = f"""You are an SEO expert. Analyse the following content and return a JSON object.

Response language: {body.language}

CONTENT:
{body.content[:8000]}

Return strict JSON only, without markdown fences, with this exact structure:
{{
  "score": <integer 0-100>,
  "breakdown": {{
    "keywordDensity": <integer 0-100>,
    "readability": <integer 0-100>,
    "headingStructure": <integer 0-100>,
    "metaQuality": <integer 0-100>
  }},
  "recommendations": [
    "<actionable recommendation>",
    ...
  ]
}}"""
    result = await _generate_analysis_json(
        prompt,
        system_prompt="You analyze marketing content and return strict JSON only.",
    )
    return result if isinstance(result, dict) else {"score": 0, "breakdown": {}, "recommendations": []}


@router.post("/ai-detection")
async def ai_detection(
    body: ContentAnalysisRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """
    Estimate the probability that content was AI-generated.
    Uses heuristic analysis via DeepSeek (not a dedicated detector model).
    Returns: score 0-100, indicators, suggestions to humanise.
    """
    prompt = (
        "You are an AI content detection expert. Analyse the following text and estimate:\n"
        "1. AI probability score (0-100, where 100 = definitely AI-generated)\n"
        "2. Key indicators that suggest AI or human authorship\n"
        "3. Specific suggestions to make the text sound more human\n\n"
        f"Response language: {body.language}\n\n"
        f"Text to analyse:\n{body.content[:4000]}\n\n"
        'Return strict JSON only, without markdown fences: {"score": 0-100, "verdict": "...", '
        '"indicators": ["..."], "suggestions": ["..."]}'
    )
    result = await _generate_analysis_json(
        prompt,
        system_prompt="You analyze AI-writing signals and return strict JSON only.",
    )
    return result if isinstance(result, dict) else {"score": 0, "verdict": "analysis_failed", "indicators": [], "suggestions": []}


@router.post("/plagiarism")
async def plagiarism_check(
    body: ContentAnalysisRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """
    Lightweight originality analysis using DeepSeek.
    Note: This is NOT a full web plagiarism check; it analyses structural
    patterns and common phrases that may indicate derivative content.
    Returns: originality_score, flagged_phrases, recommendations.
    """
    prompt = (
        "You are a content originality expert. Analyse the following text for:\n"
        "1. Originality score (0-100, where 100 = fully original)\n"
        "2. Any phrases that sound generic, cliched, or potentially derivative\n"
        "3. Recommendations to improve originality\n\n"
        f"Response language: {body.language}\n\n"
        f"Text:\n{body.content[:4000]}\n\n"
        'Return strict JSON only, without markdown fences: {"originality_score": 0-100, "verdict": "...", '
        '"flagged_phrases": ["..."], "recommendations": ["..."]}'
    )
    result = await _generate_analysis_json(
        prompt,
        system_prompt="You analyze content originality and return strict JSON only.",
    )
    return result if isinstance(result, dict) else {
        "originality_score": 75,
        "verdict": "analysis_inconclusive",
        "flagged_phrases": [],
        "recommendations": [],
    }
