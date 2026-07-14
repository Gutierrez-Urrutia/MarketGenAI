"""
Tests for app/workers/tasks/content_tasks.py — specifically the
storage_service call inside task_publish_book's pdf_export channel,
which had swapped/invented arguments that nothing caught before
(it mocked storage_service.upload_bytes as an opaque AsyncMock and never
verified what the Supabase client actually received).
"""
from __future__ import annotations

import sys
from unittest.mock import AsyncMock, MagicMock, patch

from tests.conftest import fake_book

from app.workers.tasks import content_tasks


def test_publish_book_pdf_export_uploads_correct_bytes_to_supabase():
    """Regression guard for the swapped-argument bug: the Supabase client's
    upload() must receive the actual PDF bytes as `file` and the storage
    path as `path` — not the other way around."""
    book = fake_book({"id": "book-pdf", "status": "generated"})
    captured = {}

    fake_client = MagicMock()

    def fake_upload(path, file, file_options):
        captured["path"] = path
        captured["file"] = file
        captured["file_options"] = file_options

    fake_client.storage.from_.return_value.upload.side_effect = fake_upload
    fake_client.storage.from_.return_value.get_public_url.return_value = "https://fake/book.pdf"
    fake_client.storage.from_.return_value.create_signed_url.return_value = {"signedURL": "https://fake/signed.pdf"}

    with (
        patch.object(content_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(content_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(content_tasks.books_repo, "update", new_callable=AsyncMock),
        patch("app.services.firestore_service.assets_repo.create", new_callable=AsyncMock),
        patch("app.services.storage_service.get_supabase", return_value=fake_client),
        # weasyprint isn't expected to work on Vercel (no native GTK/Pango
        # libs) — force the same clean ImportError the code already handles,
        # instead of relying on whatever native-lib error the local machine
        # happens to raise.
        patch.dict(sys.modules, {"weasyprint": None}),
    ):
        content_tasks.task_publish_book(
            "job-1", book, [], {"channels": ["pdf_export"]},
        )

    # The uploaded bytes must be actual PDF content, not the storage path string.
    assert isinstance(captured["file"], bytes)
    assert captured["file"].startswith(b"%PDF")
    # The storage path must be the string path, not the PDF bytes.
    assert captured["path"] == f"exports/{book['id']}/book.pdf"


def test_translate_book_uses_deepseek_and_preserves_task_contract():
    book = fake_book({"id": "book-translate"})
    chapters = [{
        "id": "chapter-1",
        "title": "Intro",
        "content": "<h2>Hello</h2><p>World</p>",
        "orderIndex": 0,
    }]

    with (
        patch.object(content_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(content_tasks.jobs_repo, "complete_job", new_callable=AsyncMock) as complete_job,
        patch.object(content_tasks.books_repo, "create_chapter", new_callable=AsyncMock) as create_chapter,
        patch.object(content_tasks.deepseek_service, "generate_text",
                     new_callable=AsyncMock, return_value="<h2>Hola</h2><p>Mundo</p>") as generate_text,
    ):
        content_tasks.task_translate_book(
            "job-translate",
            book,
            chapters,
            {"targetLanguage": "Spanish", "adaptCulturalNuances": True, "saveAs": "new_version"},
        )

    generate_text.assert_awaited_once()
    prompt, kwargs = generate_text.call_args.args[0], generate_text.call_args.kwargs
    assert "Translate the following HTML content to Spanish" in prompt
    assert "Preserve all HTML tags and structure exactly" in prompt
    assert kwargs["system_prompt"].startswith("You are a professional translator")
    create_chapter.assert_awaited_once()
    created = create_chapter.call_args.args[1]
    assert created["content"] == "<h2>Hola</h2><p>Mundo</p>"
    assert created["language"] == "Spanish"
    complete_job.assert_awaited_once()
