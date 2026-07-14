from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services import book_ai_service


@pytest.mark.asyncio
async def test_generate_chapters_includes_requested_language():
    with (
        patch.object(book_ai_service.deepseek_service, "generate_text", new_callable=AsyncMock, return_value='[{"title":"T","description":"D"}]') as generate_text,
        patch.object(book_ai_service, "_safe_json", return_value=[{"title": "T", "description": "D"}]),
    ):
        await book_ai_service.generate_chapters(
            title="Libro",
            description="Descripcion",
            keywords=["ia"],
            chapter_count=1,
            language="es",
        )

    prompt = generate_text.call_args.args[0]
    assert "Language: es" in prompt


@pytest.mark.asyncio
async def test_generate_chapter_content_includes_requested_language():
    with patch.object(
        book_ai_service.deepseek_service,
        "generate_text",
        new_callable=AsyncMock,
        return_value="<h2>Contenido</h2>",
    ) as generate_text:
        await book_ai_service.generate_chapter_content(
            book_title="Libro",
            book_description="Descripcion",
            chapter_title="Capitulo",
            chapter_description="Detalle",
            language="es",
        )

    prompt = generate_text.call_args.args[0]
    assert "Language: es" in prompt


@pytest.mark.asyncio
async def test_generate_social_posts_includes_requested_language():
    with patch.object(
        book_ai_service.deepseek_service,
        "generate_text",
        new_callable=AsyncMock,
        return_value="Publicacion",
    ) as generate_text:
        await book_ai_service.generate_social_posts(
            book_title="Libro",
            content_summary="Resumen",
            platforms=["linkedin"],
            language="es",
        )

    prompt = generate_text.call_args.args[0]
    assert "Language: es" in prompt
