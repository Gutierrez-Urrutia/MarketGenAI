"""Tests for the /api/v1/books/{id}/publish and translate endpoints."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import FAKE_USER_SUB, fake_book, fake_chapter, fake_job

API = "/api/v1/books"


@pytest.mark.asyncio
async def test_publish_book_enqueues_job(client):
    """POST /books/{id}/publish returns 202 with a job_id."""
    book    = fake_book({"status": "generated"})
    chapter = fake_chapter()
    job     = fake_job("book_publish")

    with (
        patch("app.routers.publishing.books_repo.get",          new_callable=AsyncMock, return_value=book),
        patch("app.routers.publishing.books_repo.get_chapters", new_callable=AsyncMock, return_value=[chapter]),
        patch("app.routers.publishing.jobs_repo.create_job",    new_callable=AsyncMock, return_value=job),
        patch("app.routers.publishing.task_publish_book.delay", return_value=None),
    ):
        resp = await client.post(f"{API}/book-001/publish", json={
            "channels": ["pdf_export"],
        })

    assert resp.status_code == 202
    assert resp.json()["job_id"] == "job-001"


@pytest.mark.asyncio
async def test_publish_book_accepts_scheduled_multichannel_payload(client):
    """POST /books/{id}/publish preserves channel and scheduling options."""
    book    = fake_book({"status": "generated"})
    chapter = fake_chapter()
    job     = fake_job("book_publish")

    with (
        patch("app.routers.publishing.books_repo.get",          new_callable=AsyncMock, return_value=book),
        patch("app.routers.publishing.books_repo.get_chapters", new_callable=AsyncMock, return_value=[chapter]),
        patch("app.routers.publishing.jobs_repo.create_job",    new_callable=AsyncMock, return_value=job) as create_job,
        patch("app.routers.publishing.task_publish_book.delay", return_value=None) as delay,
    ):
        resp = await client.post(f"{API}/book-001/publish", json={
            "channels": ["linkedin", "wordpress", "pdf_export"],
            "publishMode": "scheduled",
            "scheduledAt": "2026-06-09T14:30:00Z",
            "includeCovers": True,
            "watermark": "Client review",
        })

    assert resp.status_code == 202
    options = create_job.await_args.args[2]["options"]
    assert options["channels"] == ["linkedin", "wordpress", "pdf_export"]
    assert options["publishMode"] == "scheduled"
    assert options["watermark"] == "Client review"
    delay_options = delay.call_args.args[3]
    assert delay_options["scheduledAt"].startswith("2026-06-09T14:30:00")


@pytest.mark.asyncio
async def test_publish_book_requires_schedule_datetime_for_scheduled_mode(client):
    book    = fake_book({"status": "generated"})
    chapter = fake_chapter()

    with (
        patch("app.routers.publishing.books_repo.get",          new_callable=AsyncMock, return_value=book),
        patch("app.routers.publishing.books_repo.get_chapters", new_callable=AsyncMock, return_value=[chapter]),
    ):
        resp = await client.post(f"{API}/book-001/publish", json={
            "channels": ["linkedin"],
            "publishMode": "scheduled",
        })

    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_publish_book_requires_generated_status(client):
    """POST /books/{id}/publish returns 422 when book is still a draft."""
    book = fake_book({"status": "draft"})
    with patch("app.routers.publishing.books_repo.get", new_callable=AsyncMock, return_value=book):
        resp = await client.post(f"{API}/book-001/publish", json={
            "channels": ["pdf_export"],
        })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_publish_book_not_found(client):
    with patch("app.routers.publishing.books_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.post(f"{API}/nonexistent/publish", json={"channels": ["pdf_export"]})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_publish_book_forbidden(client):
    other = fake_book({"status": "generated", "userId": "other-user"})
    with patch("app.routers.publishing.books_repo.get", new_callable=AsyncMock, return_value=other):
        resp = await client.post(f"{API}/book-001/publish", json={"channels": ["pdf_export"]})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_translate_book_enqueues_job(client):
    """POST /books/{id}/translate returns 202 with a job_id."""
    book    = fake_book()
    chapter = fake_chapter()
    job     = fake_job("book_translation")

    with (
        patch("app.routers.publishing.books_repo.get",           new_callable=AsyncMock, return_value=book),
        patch("app.routers.publishing.books_repo.get_chapters",  new_callable=AsyncMock, return_value=[chapter]),
        patch("app.routers.publishing.jobs_repo.create_job",     new_callable=AsyncMock, return_value=job),
        patch("app.routers.publishing.task_translate_book.delay", return_value=None),
    ):
        resp = await client.post(f"{API}/book-001/translate", json={
            "targetLanguage":       "French",
            "adaptCulturalNuances": True,
            "saveAs":               "new_version",
        })

    assert resp.status_code == 202
    assert resp.json()["job_id"] == "job-001"


@pytest.mark.asyncio
async def test_translate_missing_target_language(client):
    """POST /books/{id}/translate without targetLanguage returns 422."""
    resp = await client.post(f"{API}/book-001/translate", json={"saveAs": "overwrite"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_get_publish_status(client):
    """GET /books/{id}/publish/status returns the history list."""
    history = [{"channel": "pdf_export", "status": "success", "url": "https://..."}]
    book = fake_book({"publishHistory": history, "status": "published"})

    with patch("app.routers.publishing.books_repo.get", new_callable=AsyncMock, return_value=book):
        resp = await client.get(f"{API}/book-001/publish/status")

    assert resp.status_code == 200
    data = resp.json()
    assert data["bookId"] == "book-001"
    assert len(data["channels"]) == 1
    assert data["channels"][0]["channel"] == "pdf_export"
