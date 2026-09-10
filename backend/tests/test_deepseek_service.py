"""Tests for the shared DeepSeek service."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.services import deepseek_service


@pytest.mark.asyncio
async def test_generate_text_uses_configured_deepseek_client():
    response = MagicMock()
    response.choices[0].message.content = "Generated content"
    client = MagicMock()
    client.chat.completions.create.return_value = response

    with (
        patch("app.services.deepseek_service.OpenAI", return_value=client) as openai,
        patch.object(deepseek_service.settings, "deepseek_api_key", "test-key"),
        patch.object(deepseek_service.settings, "deepseek_base_url", "https://deepseek.test"),
        patch.object(deepseek_service.settings, "llm_default_timeout_seconds", 45),
    ):
        result = await deepseek_service.generate_text(
            "Campaign prompt",
            system_prompt="Marketing system prompt",
            temperature=0.3,
            timeout=12,
        )

    assert result == "Generated content"
    openai.assert_called_once_with(
        api_key="test-key",
        base_url="https://deepseek.test",
        timeout=12,
    )
    client.chat.completions.create.assert_called_once_with(
        model="deepseek-v4-pro",
        messages=[
            {"role": "system", "content": "Marketing system prompt"},
            {"role": "user", "content": "Campaign prompt"},
        ],
        temperature=0.3,
        stream=False,
        reasoning_effort="high",
        extra_body={"thinking": {"type": "enabled"}},
        timeout=12,
    )


@pytest.mark.asyncio
async def test_generate_text_can_send_explicit_message_history():
    response = MagicMock()
    response.choices[0].message.content = "Chat reply"
    client = MagicMock()
    client.chat.completions.create.return_value = response

    messages = [
        {"role": "user", "content": "Earlier question"},
        {"role": "assistant", "content": "Earlier answer"},
        {"role": "user", "content": "Current question"},
    ]

    with patch("app.services.deepseek_service.OpenAI", return_value=client):
        result = await deepseek_service.generate_text(
            "Current question",
            system_prompt="Chat system prompt",
            messages=messages,
            timeout=20,
        )

    assert result == "Chat reply"
    client.chat.completions.create.assert_called_once_with(
        model="deepseek-v4-pro",
        messages=[
            {"role": "system", "content": "Chat system prompt"},
            *messages,
        ],
        temperature=0.7,
        stream=False,
        reasoning_effort="high",
        extra_body={"thinking": {"type": "enabled"}},
        timeout=20,
    )
