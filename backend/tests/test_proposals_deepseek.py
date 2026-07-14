"""Tests for the DeepSeek-backed proposal helper."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.routers import proposals


@pytest.mark.asyncio
async def test_proposal_content_uses_shared_deepseek_service(tmp_path):
    with (
        patch(
            "app.routers.proposals.deepseek_service.generate_text",
            new_callable=AsyncMock,
            return_value="<p>Generated proposal</p>",
        ) as generate_text,
        patch("app.routers.proposals._output_dir", return_value=tmp_path),
    ):
        result = await proposals._generate_proposal_content(
            "AI Proposal",
            "Acme",
            "Automate operations",
        )

    generate_text.assert_awaited_once()
    assert result["content"] == "<p>Generated proposal</p>"
    assert Path(result["filePath"]).exists()
