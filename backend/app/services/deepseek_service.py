"""Shared DeepSeek text-generation client."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional, Sequence

from openai import APITimeoutError, OpenAI

from app.config import settings

logger = logging.getLogger("marketgen.llm")


class LLMTimeoutError(TimeoutError):
    """Raised when a configured LLM call timeout is exceeded."""


def _generate_text_sync(
    prompt: str,
    system_prompt: str,
    temperature: float,
    timeout: float,
    messages: Sequence[dict[str, str]] | None = None,
) -> str:
    request_messages = (
        [{"role": "system", "content": system_prompt}, *messages]
        if messages is not None
        else [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]
    )

    client = OpenAI(
        base_url=settings.deepseek_base_url or "https://api.deepseek.com",
        api_key=settings.deepseek_api_key,
        timeout=timeout,
    )
    model = settings.deepseek_model or "deepseek-v4-flash"

    t0 = time.time()
    timeout_desc = f"{timeout}s" if timeout else "sin timeout (ilimitado)"
    logger.info(f"⏳ [DeepSeek API] Consultando modelo '{model}' ({len(prompt)} chars, timeout={timeout_desc})...")

    try:
        response = client.chat.completions.create(
            model=model,
            messages=request_messages,
            temperature=temperature if temperature is not None else 0.7,
            stream=False,
            reasoning_effort="high",
            extra_body={"thinking": {"type": "enabled"}},
            timeout=timeout,
        )
        elapsed = time.time() - t0
        content = response.choices[0].message.content or ""
        logger.info(f"✅ [DeepSeek API] Respuesta recibida con éxito en {elapsed:.2f}s ({len(content)} caracteres).")
        return content
    except APITimeoutError as exc:
        elapsed = time.time() - t0
        logger.error(f"❌ [DeepSeek API] Timeout después de {elapsed:.2f}s.")
        raise LLMTimeoutError(f"DeepSeek request timed out after {timeout} seconds.") from exc
    except Exception as exc:
        elapsed = time.time() - t0
        logger.error(f"❌ [DeepSeek API] Error tras {elapsed:.2f}s: {exc}")
        raise


async def generate_text(
    prompt: str,
    *,
    system_prompt: str = "You are an expert marketing writer.",
    temperature: float = 0.7,
    timeout: Optional[float] = None,
    messages: Sequence[dict[str, str]] | None = None,
) -> str:
    """Generate text with DeepSeek without blocking the async request loop.

    Defaults to timeout=None (sin timeout) so generative requests never get aborted
    mid-generation, avoiding wasted tokens.
    """
    effective_timeout = timeout if timeout is not None else settings.llm_default_timeout_seconds
    return await asyncio.to_thread(
        _generate_text_sync,
        prompt,
        system_prompt,
        temperature,
        effective_timeout,
        messages,
    )
