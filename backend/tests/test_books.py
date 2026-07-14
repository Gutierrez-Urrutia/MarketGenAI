"""
Tests for the /api/v1/books router.

All Firestore calls are replaced with AsyncMock so no real DB is needed.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import FAKE_USER_SUB, fake_book, fake_chapter, fake_job

API = "/api/v1/books"


# ── List books ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_books_empty(client):
    """GET /books returns empty list when no books exist."""
    with (
        patch("app.routers.books.books_repo.list_by_user", new_callable=AsyncMock, return_value=[]),
        patch("app.routers.books.books_repo.count", new_callable=AsyncMock, return_value=0),
    ):
        resp = await client.get(API)
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"] == []
    assert body["total"] == 0


@pytest.mark.asyncio
async def test_list_books_returns_items(client):
    """GET /books returns owned books."""
    book = fake_book()
    with (
        patch("app.routers.books.books_repo.list_by_user", new_callable=AsyncMock, return_value=[book]),
        patch("app.routers.books.books_repo.count", new_callable=AsyncMock, return_value=1),
    ):
        resp = await client.get(API)
    assert resp.status_code == 200
    items = resp.json()["data"]
    assert len(items) == 1
    assert items[0]["id"] == "book-001"


# ── Get book ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_book_success(client):
    """GET /books/{id} returns the book with chapters."""
    book = fake_book()
    chapter = fake_chapter()
    with (
        patch("app.routers.books.books_repo.get",          new_callable=AsyncMock, return_value=book),
        patch("app.routers.books.books_repo.get_chapters", new_callable=AsyncMock, return_value=[chapter]),
    ):
        resp = await client.get(f"{API}/book-001")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == "book-001"
    assert len(data["chapters"]) == 1


@pytest.mark.asyncio
async def test_get_book_not_found(client):
    """GET /books/{id} returns 404 when book doesn't exist."""
    with patch("app.routers.books.books_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.get(f"{API}/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_book_forbidden(client):
    """GET /books/{id} returns 403 for another user's book."""
    other_book = fake_book({"userId": "other-user-sub"})
    with (
        patch("app.routers.books.books_repo.get",          new_callable=AsyncMock, return_value=other_book),
        patch("app.routers.books.books_repo.get_chapters", new_callable=AsyncMock, return_value=[]),
    ):
        resp = await client.get(f"{API}/book-001")
    assert resp.status_code == 403


# ── Create book ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_book_success(client):
    """POST /books creates a book and returns 201."""
    payload = {
        "title":        "My New Book",
        "description":  "Describes AI marketing.",
        "writingStyle": "professional",
        "contentType":  "long",
        "chapterCount": 5,
    }
    created = fake_book({"title": "My New Book"})
    with patch("app.routers.books.books_repo.create", new_callable=AsyncMock, return_value=created):
        resp = await client.post(API, json=payload)
    assert resp.status_code == 201
    assert resp.json()["title"] == "My New Book"


@pytest.mark.asyncio
async def test_create_book_missing_title(client):
    """POST /books without title returns 422 validation error."""
    resp = await client.post(API, json={"description": "no title"})
    assert resp.status_code == 422


# ── Update book ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_update_book_success(client):
    """PUT /books/{id} updates and returns the book."""
    book = fake_book()
    updated = fake_book({"title": "Updated Title"})
    with (
        patch("app.routers.books.books_repo.get",    new_callable=AsyncMock, return_value=book),
        patch("app.routers.books.books_repo.update", new_callable=AsyncMock, return_value=updated),
    ):
        resp = await client.put(f"{API}/book-001", json={"title": "Updated Title"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "Updated Title"


@pytest.mark.asyncio
async def test_update_book_not_found(client):
    """PUT /books/{id} returns 404 when book doesn't exist."""
    with patch("app.routers.books.books_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.put(f"{API}/nonexistent", json={"title": "X"})
    assert resp.status_code == 404


# ── Delete book ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_book_success(client):
    """DELETE /books/{id} returns 204 No Content."""
    book = fake_book()
    with (
        patch("app.routers.books.books_repo.get_or_404", new_callable=AsyncMock, return_value=book),
        patch("app.routers.books.books_repo.get_chapters", new_callable=AsyncMock, return_value=[]),
        patch("app.routers.books.books_repo.delete", new_callable=AsyncMock, return_value=None),
    ):
        resp = await client.delete(f"{API}/book-001")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_delete_book_forbidden(client):
    """DELETE /books/{id} returns 403 for another user's book."""
    other_book = fake_book({"userId": "other-user"})
    with patch("app.routers.books.books_repo.get", new_callable=AsyncMock, return_value=other_book):
        resp = await client.delete(f"{API}/book-001")
    assert resp.status_code == 403


# ── Generate chapters ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_generate_chapters_enqueues_job(client):
    """POST /books/{id}/chapters/generate returns 202 with job_id."""
    book = fake_book()
    job  = fake_job("chapter_generation")
    with (
        patch("app.routers.books.books_repo.get_or_404", new_callable=AsyncMock, return_value=book),
        patch("app.routers.books.jobs_repo.create_job",  new_callable=AsyncMock, return_value=job),
        patch("app.routers.books.task_generate_chapters.delay", return_value=None),
    ):
        resp = await client.post(f"{API}/book-001/chapters/generate", json={"chapterCount": 5})
    assert resp.status_code == 202
    assert resp.json()["job_id"] == "job-001"


@pytest.mark.asyncio
async def test_generate_chapters_book_not_found(client):
    """POST /books/{id}/chapters/generate returns 404 if book missing."""
    with patch("app.routers.books.books_repo.get_or_404", new_callable=AsyncMock, side_effect=KeyError):
        resp = await client.post(f"{API}/nonexistent/chapters/generate", json={"chapterCount": 5})
    assert resp.status_code == 404


# ── Generate single chapter content ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_generate_single_chapter_enqueues_job(client):
    """POST /books/{id}/chapters/{cid}/content/generate returns 200 with jobId."""
    book = fake_book()
    chapter = fake_chapter()
    job = fake_job("generate_single_chapter")
    with (
        patch("app.routers.books.books_repo.get_or_404",   new_callable=AsyncMock, return_value=book),
        patch("app.routers.books.books_repo.get_chapters", new_callable=AsyncMock, return_value=[chapter]),
        patch("app.routers.books.jobs_repo.create_job",    new_callable=AsyncMock, return_value=job),
        patch("app.routers.books.task_generate_single_chapter.delay", return_value=None),
    ):
        resp = await client.post(f"{API}/book-001/chapters/chapter-001/content/generate", json={})
    assert resp.status_code == 200
    assert resp.json()["jobId"] == "job-001"


@pytest.mark.asyncio
async def test_generate_single_chapter_sync_opt_in_skips_celery(client):
    """When body.sync=True, the endpoint must run the fallback directly and
    never touch task_generate_single_chapter.delay() at all."""
    book = fake_book()
    chapter = fake_chapter()
    job = fake_job("generate_single_chapter")
    with (
        patch("app.routers.books.books_repo.get_or_404",   new_callable=AsyncMock, return_value=book),
        patch("app.routers.books.books_repo.get_chapters", new_callable=AsyncMock, return_value=[chapter]),
        patch("app.routers.books.jobs_repo.create_job",    new_callable=AsyncMock, return_value=job),
        patch("app.routers.books.task_generate_single_chapter.delay") as delay_mock,
        patch("app.routers.books._generate_single_chapter_now",
              new_callable=AsyncMock, return_value=None) as sync_fn,
    ):
        resp = await client.post(
            f"{API}/book-001/chapters/chapter-001/content/generate",
            json={"sync": True},
        )
    assert resp.status_code == 200
    assert resp.json()["jobId"] == "job-001"
    sync_fn.assert_awaited_once()
    delay_mock.assert_not_called()


@pytest.mark.asyncio
async def test_generate_single_chapter_falls_back_to_sync_when_celery_unavailable(client):
    """When .delay() can't reach the Redis broker, the endpoint must run
    _generate_single_chapter_now() synchronously instead of failing the request."""
    book = fake_book()
    chapter = fake_chapter()
    job = fake_job("generate_single_chapter")
    with (
        patch("app.routers.books.books_repo.get_or_404",   new_callable=AsyncMock, return_value=book),
        patch("app.routers.books.books_repo.get_chapters", new_callable=AsyncMock, return_value=[chapter]),
        patch("app.routers.books.jobs_repo.create_job",    new_callable=AsyncMock, return_value=job),
        patch("app.routers.books.task_generate_single_chapter.delay",
              side_effect=ConnectionError("Redis unreachable")),
        patch("app.routers.books._generate_single_chapter_now",
              new_callable=AsyncMock, return_value=None) as fallback,
    ):
        resp = await client.post(f"{API}/book-001/chapters/chapter-001/content/generate", json={})
    assert resp.status_code == 200
    assert resp.json()["jobId"] == job["id"]
    fallback.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_single_chapter_fallback_failure_fails_job(client):
    """If both .delay() and the sync fallback fail, the job must be marked
    failed — not silently swallowed."""
    book = fake_book()
    chapter = fake_chapter()
    job = fake_job("generate_single_chapter")
    with (
        patch("app.routers.books.books_repo.get_or_404",   new_callable=AsyncMock, return_value=book),
        patch("app.routers.books.books_repo.get_chapters", new_callable=AsyncMock, return_value=[chapter]),
        patch("app.routers.books.jobs_repo.create_job",    new_callable=AsyncMock, return_value=job),
        patch("app.routers.books.jobs_repo.fail_job",      new_callable=AsyncMock, return_value=None) as fail_job,
        patch("app.routers.books.task_generate_single_chapter.delay",
              side_effect=ConnectionError("Redis unreachable")),
        patch("app.routers.books._generate_single_chapter_now",
              new_callable=AsyncMock, side_effect=RuntimeError("DeepSeek timeout")),
    ):
        with pytest.raises(RuntimeError, match="DeepSeek timeout"):
            await client.post(f"{API}/book-001/chapters/chapter-001/content/generate", json={})
    fail_job.assert_awaited_once_with(job["id"], "DeepSeek timeout")
