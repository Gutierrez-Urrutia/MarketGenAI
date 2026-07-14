"""Shared DeepSeek text-generation client."""
from __future__ import annotations

import asyncio
from typing import Optional, Sequence

from openai import APITimeoutError, OpenAI

from app.config import settings


class LLMTimeoutError(TimeoutError):
    """Raised when a configured LLM call timeout is exceeded."""


def _generate_text_sync(
    prompt: str,
    system_prompt: str,
    temperature: float,
    timeout: float,
    messages: Sequence[dict[str, str]] | None = None,
) -> str:
    client = OpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
        timeout=timeout,
    )
    try:
        request_messages = (
            [{"role": "system", "content": system_prompt}, *messages]
            if messages is not None
            else [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ]
        )
        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=request_messages,
            temperature=temperature,
            timeout=timeout,
        )
    except APITimeoutError as exc:
        raise LLMTimeoutError(f"DeepSeek request timed out after {timeout} seconds.") from exc
    return response.choices[0].message.content or ""


async def generate_text(
    prompt: str,
    *,
    system_prompt: str = "You are an expert marketing writer.",
    temperature: float = 0.7,
    timeout: Optional[float] = None,
    messages: Sequence[dict[str, str]] | None = None,
) -> str:
    """Generate text with DeepSeek without blocking the async request loop."""
    effective_timeout = timeout or settings.llm_default_timeout_seconds
    return await asyncio.to_thread(
        _generate_text_sync,
        prompt,
        system_prompt,
        temperature,
        effective_timeout,
        messages,
    )
