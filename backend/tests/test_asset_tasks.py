"""
Unit tests for the asset-generation internals in
app/workers/tasks/asset_tasks.py — specifically the new
variationInstruction / temperature / forceRegenerate options
(Paso 1: soporte de regeneracion con variacion).

These call the `*_now` coroutines directly (not through the HTTP router)
and mock the AI service / the Firestore repos / storage, so no real
network or storage access happens.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.conftest import fake_book, fake_chapter

from app.workers.tasks import asset_tasks


@pytest.mark.asyncio
async def test_one_pager_appends_variation_instruction_and_passes_temperature():
    book = fake_book()
    options = {"language": "es", "style": "professional",
               "variationInstruction": "Make it punchier", "temperature": 0.9}

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock),
        patch.object(asset_tasks.deepseek_service, "generate_text",
                     new_callable=AsyncMock, return_value="<p>copy</p>") as gen_text,
        patch.object(asset_tasks, "_build_one_pager_pdf", return_value=b"pdf"),
        patch.object(asset_tasks.storage_service, "upload_bytes", new_callable=AsyncMock),
        patch.object(asset_tasks.storage_service, "get_signed_url",
                     new_callable=AsyncMock, return_value="https://example.com/f.pdf"),
    ):
        await asset_tasks.generate_one_pager_now("job-1", "asset-1", book, options)

    gen_text.assert_awaited_once()
    prompt, kwargs = gen_text.call_args.args[0], gen_text.call_args.kwargs
    assert "Make it punchier" in prompt
    assert kwargs["temperature"] == 0.9


@pytest.mark.asyncio
async def test_one_pager_without_variation_instruction_leaves_prompt_unchanged():
    book = fake_book()
    options = {"language": "es", "style": "professional"}

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock),
        patch.object(asset_tasks.deepseek_service, "generate_text",
                     new_callable=AsyncMock, return_value="<p>copy</p>") as gen_text,
        patch.object(asset_tasks, "_build_one_pager_pdf", return_value=b"pdf"),
        patch.object(asset_tasks.storage_service, "upload_bytes", new_callable=AsyncMock),
        patch.object(asset_tasks.storage_service, "get_signed_url",
                     new_callable=AsyncMock, return_value="https://example.com/f.pdf"),
    ):
        await asset_tasks.generate_one_pager_now("job-1", "asset-1", book, options)

    prompt, kwargs = gen_text.call_args.args[0], gen_text.call_args.kwargs
    assert "variation instruction" not in prompt.lower()
    # temperature omitted entirely when not provided, so deepseek_service's
    # own default (0.7) applies — same "no explicit override" behavior as before.
    assert "temperature" not in kwargs


@pytest.mark.asyncio
async def test_whitepaper_skips_regeneration_by_default_when_content_exists():
    """Regression guard: existing chapter content must not be overwritten
    unless forceRegenerate is explicitly set."""
    book = fake_book()
    chapters = [fake_chapter({"content": "<p>already written</p>"})]
    options = {"style": "academic"}

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock),
        patch.object(asset_tasks.book_ai_service, "generate_chapter_content",
                     new_callable=AsyncMock) as gen_chapter,
        patch.object(asset_tasks, "_build_whitepaper_pdf", return_value=b"pdf"),
        patch.object(asset_tasks.storage_service, "upload_bytes", new_callable=AsyncMock),
        patch.object(asset_tasks.storage_service, "get_signed_url",
                     new_callable=AsyncMock, return_value="https://example.com/f.pdf"),
    ):
        await asset_tasks.generate_whitepaper_now("job-1", "asset-1", book, chapters, options)

    gen_chapter.assert_not_awaited()


@pytest.mark.asyncio
async def test_whitepaper_force_regenerate_overwrites_existing_content_with_variation():
    book = fake_book()
    chapters = [fake_chapter({"content": "<p>already written</p>"})]
    options = {"style": "academic", "forceRegenerate": True,
               "variationInstruction": "More casual tone", "temperature": 0.5}

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock),
        patch.object(asset_tasks.book_ai_service, "generate_chapter_content",
                     new_callable=AsyncMock, return_value="<p>new content</p>") as gen_chapter,
        patch.object(asset_tasks, "_build_whitepaper_pdf", return_value=b"pdf"),
        patch.object(asset_tasks.storage_service, "upload_bytes", new_callable=AsyncMock),
        patch.object(asset_tasks.storage_service, "get_signed_url",
                     new_callable=AsyncMock, return_value="https://example.com/f.pdf"),
    ):
        await asset_tasks.generate_whitepaper_now("job-1", "asset-1", book, chapters, options)

    gen_chapter.assert_awaited_once()
    kwargs = gen_chapter.call_args.kwargs
    assert kwargs["variation_instruction"] == "More casual tone"
    assert kwargs["temperature"] == 0.5
    assert chapters[0]["content"] == "<p>new content</p>"


@pytest.mark.asyncio
async def test_whitepaper_saves_content_preview_on_asset():
    """The asset doc must get a `content` preview (title + description +
    the first paragraphs of chapter 1) so the card can show something
    real instead of the generic 'ready to use' placeholder — matches
    what one-pager already does with its full HTML content."""
    book = fake_book({"title": "AI Marketing Playbook", "description": "A practical guide."})
    chapters = [fake_chapter({
        "content": "<p>First paragraph.</p><p>Second paragraph.</p><p>Third.</p><p>Fourth (should be excluded).</p>",
    })]
    options = {"style": "academic"}

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock) as assets_update,
        patch.object(asset_tasks, "_build_whitepaper_pdf", return_value=b"pdf"),
        patch.object(asset_tasks.storage_service, "upload_bytes", new_callable=AsyncMock),
        patch.object(asset_tasks.storage_service, "get_signed_url",
                     new_callable=AsyncMock, return_value="https://example.com/f.pdf"),
    ):
        await asset_tasks.generate_whitepaper_now("job-1", "asset-1", book, chapters, options)

    # The final update call is the "ready" one that carries the preview.
    final_data = assets_update.call_args_list[-1].args[1]
    assert final_data["status"] == "ready"
    preview = final_data["content"]
    assert "AI Marketing Playbook" in preview
    assert "A practical guide." in preview
    assert "First paragraph." in preview
    assert "Second paragraph." in preview
    assert "Third." in preview
    assert "Fourth (should be excluded)." not in preview


def _fake_supabase_client(captured: dict) -> MagicMock:
    """A Supabase client double that records exactly what upload()/
    create_signed_url() receive, so tests can catch argument-order or
    kwarg-name regressions instead of just asserting storage_service
    'was called' (which is what let the original bug slip through)."""
    client = MagicMock()

    def fake_upload(path, file, file_options):
        captured["path"] = path
        captured["file"] = file
        captured["file_options"] = file_options

    client.storage.from_.return_value.upload.side_effect = fake_upload
    client.storage.from_.return_value.get_public_url.return_value = "https://fake/public.pdf"

    def fake_create_signed_url(storage_path, expires_in_seconds):
        captured["signed_path"] = storage_path
        captured["expires_in_seconds"] = expires_in_seconds
        return {"signedURL": "https://fake/signed.pdf"}

    client.storage.from_.return_value.create_signed_url.side_effect = fake_create_signed_url
    return client


@pytest.mark.asyncio
async def test_whitepaper_uploads_pdf_bytes_not_the_storage_path():
    """Regression guard for the swapped-argument bug: upload_bytes(data,
    storage_path, content_type) must receive the actual PDF bytes as
    `data` and the asset path as `storage_path` — not the other way
    around — and get_signed_url must receive expires_in_seconds, not a
    made-up `expires_in` kwarg. Mocks the Supabase client itself (not
    storage_service), so a regression in either asset_tasks.py's call
    site or storage_service.py's signature would fail this test."""
    book = fake_book()
    chapters = [fake_chapter({"content": "<p>already written</p>"})]
    options = {"style": "academic"}
    captured: dict = {}

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock),
        patch.object(asset_tasks, "_build_whitepaper_pdf", return_value=b"%PDF-1.4 whitepaper"),
        patch("app.services.storage_service.get_supabase", return_value=_fake_supabase_client(captured)),
    ):
        await asset_tasks.generate_whitepaper_now("job-1", "asset-42", book, chapters, options)

    assert captured["file"] == b"%PDF-1.4 whitepaper"
    assert captured["path"] == "assets/asset-42.whitepaper.pdf"
    assert captured["signed_path"] == "assets/asset-42.whitepaper.pdf"
    assert captured["expires_in_seconds"] == 86400 * 7


@pytest.mark.asyncio
async def test_one_pager_uploads_pdf_bytes_not_the_storage_path():
    book = fake_book()
    options = {"language": "es", "style": "professional"}
    captured: dict = {}

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock),
        patch.object(asset_tasks.deepseek_service, "generate_text",
                     new_callable=AsyncMock, return_value="<p>copy</p>"),
        patch.object(asset_tasks, "_build_one_pager_pdf", return_value=b"%PDF-1.4 onepager"),
        patch("app.services.storage_service.get_supabase", return_value=_fake_supabase_client(captured)),
    ):
        await asset_tasks.generate_one_pager_now("job-1", "asset-7", book, options)

    assert captured["file"] == b"%PDF-1.4 onepager"
    assert captured["path"] == "assets/asset-7.one-pager.pdf"
    assert captured["signed_path"] == "assets/asset-7.one-pager.pdf"
    assert captured["expires_in_seconds"] == 86400 * 7


@pytest.mark.asyncio
async def test_social_posts_loops_per_platform_with_deepseek():
    """book_ai_service.generate_social_posts (DeepSeek) must call the LLM
    once per requested platform and return the same
    {platform, content, characterCount} asset preview shape."""
    book = fake_book()
    options = {"platforms": ["linkedin", "twitter"], "tone": "professional",
               "variationInstruction": "Add a question hook", "temperature": 1.1}

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock),
        patch.object(asset_tasks.deepseek_service, "generate_text",
                     new_callable=AsyncMock, return_value="Great post content") as gen_text,
    ):
        posts = await asset_tasks.generate_social_posts_now("job-1", "asset-1", book, None, options)

    assert gen_text.await_count == 2
    assert [post["platform"] for post in posts] == ["linkedin", "twitter"]
    assert all(post["content"] == "Great post content" for post in posts)
    assert all(post["characterCount"] == len("Great post content") for post in posts)
    for call in gen_text.call_args_list:
        prompt, kwargs = call.args[0], call.kwargs
        assert "Add a question hook" in prompt
        assert kwargs["temperature"] == 1.1


@pytest.mark.asyncio
async def test_social_posts_default_platforms_use_facebook_not_instagram():
    """Instagram was replaced by Facebook for this generator — when no
    platforms are specified, the default list must include facebook and
    must not include instagram anywhere (platform name, prompt, or the
    per-platform system_prompt)."""
    book = fake_book()
    options = {"tone": "professional"}  # no "platforms" key -> uses the default

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock),
        patch.object(asset_tasks.deepseek_service, "generate_text",
                     new_callable=AsyncMock, return_value="Great post content") as gen_text,
    ):
        posts = await asset_tasks.generate_social_posts_now("job-1", "asset-1", book, None, options)

    platforms = [post["platform"] for post in posts]
    assert "facebook" in platforms
    assert "instagram" not in platforms
    for call in gen_text.call_args_list:
        prompt, kwargs = call.args[0], call.kwargs
        assert "instagram" not in prompt.lower()
        assert "instagram" not in kwargs.get("system_prompt", "").lower()


@pytest.mark.asyncio
async def test_social_posts_without_variation_instruction_leaves_prompt_unchanged():
    book = fake_book()
    options = {"platforms": ["linkedin"], "tone": "professional"}

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock),
        patch.object(asset_tasks.deepseek_service, "generate_text",
                     new_callable=AsyncMock, return_value="Great post content") as gen_text,
    ):
        await asset_tasks.generate_social_posts_now("job-1", "asset-1", book, None, options)

    prompt, kwargs = gen_text.call_args.args[0], gen_text.call_args.kwargs
    assert "variation instruction" not in prompt.lower()
    assert "temperature" not in kwargs


@pytest.mark.asyncio
async def test_infographic_appends_variation_instruction_and_passes_temperature():
    book = fake_book()
    options = {"variationInstruction": "Focus on ROI stats", "temperature": 0.3}

    with (
        patch.object(asset_tasks.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(asset_tasks.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(asset_tasks.assets_repo, "update", new_callable=AsyncMock) as assets_update,
        patch.object(asset_tasks.deepseek_service, "generate_text",
                     new_callable=AsyncMock, return_value='{"title": "t"}') as gen_text,
        patch.object(asset_tasks.book_ai_service, "_safe_json", return_value={"title": "t"}),
        patch.object(asset_tasks, "build_infographic_pdf", return_value=b"%PDF-1.4 infographic") as build_pdf,
        patch.object(asset_tasks.storage_service, "upload_bytes", new_callable=AsyncMock) as upload,
        patch.object(asset_tasks.storage_service, "get_signed_url",
                     new_callable=AsyncMock, return_value="https://example.com/infographic.pdf"),
    ):
        await asset_tasks.generate_infographic_now("job-1", "asset-1", book, options)

    prompt, kwargs = gen_text.call_args.args[0], gen_text.call_args.kwargs
    assert "Focus on ROI stats" in prompt
    assert kwargs["temperature"] == 0.3
    build_pdf.assert_called_once()
    upload.assert_awaited_once_with(b"%PDF-1.4 infographic", "assets/asset-1.infographic.pdf", "application/pdf")
    final_data = assets_update.call_args_list[-1].args[1]
    assert final_data["content"] == '{"title": "t"}'
    assert final_data["storagePath"] == "assets/asset-1.infographic.pdf"
    assert final_data["downloadUrl"] == "https://example.com/infographic.pdf"
    assert final_data["mimeType"] == "application/pdf"
