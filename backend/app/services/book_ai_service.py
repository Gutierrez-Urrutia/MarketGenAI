"""Book Concepts AI helpers backed by DeepSeek."""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

from app.config import settings
from app.services import deepseek_service

STYLE_PROMPTS = {
    "professional": "Use a formal, authoritative, and polished tone.",
    "conversational": "Use a friendly, approachable, and natural tone.",
    "academic": "Use rigorous academic language with citations where appropriate.",
    "creative": "Use vivid, engaging, and imaginative language.",
    "technical": "Use precise technical language with clear definitions.",
    "persuasive": "Use compelling, evidence-backed language designed to persuade.",
}

CONTENT_LENGTH = {
    "full": "Write a comprehensive piece of 2000-4000 words.",
    "long": "Write a detailed, well-structured piece of 1500-2500 words. Include concrete examples, subheadings, and actionable insights.",
    "short": "Write a concise piece of 100-280 characters.",
}

SOCIAL_LIMITS = {
    "linkedin":  {"chars": 3000, "note": "Professional tone, include 3-5 relevant hashtags."},
    "twitter":   {"chars": 280,  "note": "Punchy and conversational. One key insight."},
    "facebook":  {"chars": 2000, "note": "Engaging, encourage shares. Friendly tone."},
    "medium":    {"chars": 5000, "note": "Long-form intro paragraph with a compelling hook."},
}


def _clean_fenced_text(text: str) -> str:
    cleaned = re.sub(r"```(?:json|html)?\s*", "", text or "").strip()
    return cleaned.rstrip("`").strip()


def _safe_json(text: str) -> Any:
    return json.loads(_clean_fenced_text(text))


async def generate_chapters(
    title: str,
    description: str,
    keywords: List[str],
    chapter_count: int = 5,
    language: str = "en",
) -> List[Dict[str, str]]:
    keywords_str = ", ".join(keywords) if keywords else "none provided"
    prompt = f"""
Book title: {title}
Book description: {description}
Keywords: {keywords_str}

Generate exactly {chapter_count} chapters for this book concept.
Language: {language}. Every title and description must be in this language.

Return ONLY a valid JSON array. Each item must contain exactly:
- "title": chapter title, max 80 characters
- "description": one paragraph writing prompt for the chapter, 100-200 words

Example:
[
  {{"title": "Chapter Title", "description": "Chapter writing prompt..."}}
]
"""
    raw = await deepseek_service.generate_text(
        prompt,
        system_prompt="You are an expert content strategist. Return strict JSON only.",
        timeout=settings.llm_long_timeout_seconds,
    )
    chapters = _safe_json(raw)
    if not isinstance(chapters, list):
        raise ValueError("DeepSeek chapter response must be a JSON array.")
    return chapters[:chapter_count]


async def generate_chapter_content(
    book_title: str,
    book_description: str,
    chapter_title: str,
    chapter_description: str,
    content_type: str = "long",
    style: str = "professional",
    variation_instruction: str | None = None,
    temperature: float | None = None,
    language: str = "en",
) -> str:
    length_instruction = CONTENT_LENGTH.get(content_type, CONTENT_LENGTH["long"])
    style_instruction = STYLE_PROMPTS.get(style, STYLE_PROMPTS["professional"])
    prompt = f"""
Book: {book_title}
Book context: {book_description}

Chapter: {chapter_title}
Chapter directive: {chapter_description}

Instructions:
- Language: {language}. Every word in the generated content must be in this language.
- {length_instruction}
- {style_instruction}
- Format the response as clean semantic HTML using h2, h3, p, ul, ol, strong, and em tags.
- Do not include html, head, or body wrapper tags.
- Do not include preamble, markdown fences, or meta-commentary. Output the chapter content directly.
"""
    if variation_instruction:
        prompt += f"\nAdditional variation instruction:\n{variation_instruction}\n"

    extra_kwargs = {}
    if temperature is not None:
        extra_kwargs["temperature"] = temperature

    content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You are an expert long-form content writer specializing in business and marketing books. Write rich, substantive content with depth and examples. Return clean HTML only.",
        timeout=settings.llm_long_timeout_seconds,
        **extra_kwargs,
    )
    return _clean_fenced_text(content)


async def refine_content(existing_content: str, instruction: str, language: str = "en") -> str:
    prompt = f"""
Existing HTML content:
{existing_content}

Refinement instruction:
{instruction}

Return the improved content as clean HTML only. Preserve the original meaning unless the instruction says otherwise.
Language: {language}. Every word in the refined content must be in this language.
"""
    content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You refine long-form marketing content. Return clean HTML only.",
        timeout=settings.llm_long_timeout_seconds,
    )
    return _clean_fenced_text(content)


async def generate_social_posts(
    book_title: str,
    content_summary: str,
    platforms: List[str],
    tone: str = "professional",
    variation_instruction: str | None = None,
    temperature: float | None = None,
    language: str = "en",
) -> List[Dict[str, Any]]:
    """Generate one social post per platform with DeepSeek.

    Keeps the existing {platform, content, characterCount} preview shape.
    """
    extra_kwargs = {}
    if temperature is not None:
        extra_kwargs["temperature"] = temperature

    results = []
    for platform in platforms:
        meta = SOCIAL_LIMITS.get(platform, {"chars": 1000, "note": ""})
        prompt = f"""Write a single social media post for {platform.upper()}.

Book/Content: {book_title}
Summary: {content_summary}
Tone: {tone}
Platform rules: Max {meta['chars']} characters. {meta['note']}
Language: {language}. Every word must be in this language.

Output ONLY the post text. No labels, no quotes, no commentary.
"""
        if variation_instruction:
            prompt += f"\nAdditional variation instruction:\n{variation_instruction}\n"

        text = await deepseek_service.generate_text(
            prompt,
            system_prompt=f"You are an expert social media copywriter for {platform.upper()}. Return plain post text only, no labels, no quotes, no markdown.",
            timeout=settings.llm_default_timeout_seconds,
            **extra_kwargs,
        )
        text = _clean_fenced_text(text)
        results.append({
            "platform":       platform,
            "content":        text,
            "characterCount": len(text),
        })

    return results
