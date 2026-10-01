"""Tests for the /api/v1/assets router."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import FAKE_USER_SUB, fake_book, fake_job

API = "/api/v1"


def fake_asset(overrides: dict | None = None) -> dict:
    base = {
        "id":          "asset-001",
        "userId":      FAKE_USER_SUB,
        "bookId":      "book-001",
        "type":        "one_pager",
        "title":       "One-Pager — Test Book",
        "status":      "ready",
        "storagePath": "exports/book-001/one-pager.pdf",
        "downloadUrl": "https://storage.example.com/one-pager.pdf",
        "createdAt":   "2024-01-01T00:00:00Z",
        "updatedAt":   "2024-01-01T00:00:00Z",
    }
    if overrides:
        base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_list_assets_empty(client):
    with (
        patch("app.routers.assets.assets_repo.list",  new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.count", new_callable=AsyncMock, return_value=0),
    ):
        resp = await client.get(f"{API}/assets")
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_list_assets_with_type_filter(client):
    asset = fake_asset()
    with (
        patch("app.routers.assets.assets_repo.list",  new_callable=AsyncMock, return_value=[asset]),
        patch("app.routers.assets.assets_repo.count", new_callable=AsyncMock, return_value=1),
    ):
        resp = await client.get(f"{API}/assets?asset_type=one_pager")
    assert resp.status_code == 200
    assert resp.json()["items"][0]["type"] == "one_pager"


@pytest.mark.asyncio
async def test_get_asset_not_found(client):
    with patch("app.routers.assets.assets_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.get(f"{API}/assets/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_asset_forbidden(client):
    other = fake_asset({"userId": "other-user"})
    with patch("app.routers.assets.assets_repo.get", new_callable=AsyncMock, return_value=other):
        resp = await client.get(f"{API}/assets/asset-001")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_delete_asset_success(client):
    asset = fake_asset()
    with (
        patch("app.routers.assets.assets_repo.get",               new_callable=AsyncMock, return_value=asset),
        patch("app.routers.assets.storage_service.delete_file",   new_callable=AsyncMock, return_value=None) as delete_file,
        patch("app.routers.assets.assets_repo.delete",            new_callable=AsyncMock, return_value=None),
    ):
        resp = await client.delete(f"{API}/assets/asset-001")
    assert resp.status_code == 204
    delete_file.assert_awaited_once_with(asset["storagePath"])


@pytest.mark.asyncio
async def test_generate_one_pager_enqueues_celery_task(client):
    book = fake_book({"status": "generated"})
    job  = fake_job("one_pager_generation")
    new_asset = fake_asset({"status": "pending"})
    with (
        patch("app.routers.assets.books_repo.get",         new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.assets_repo.list",       new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.create",     new_callable=AsyncMock, return_value=new_asset),
        patch("app.routers.assets.jobs_repo.create_job",   new_callable=AsyncMock, return_value=job),
        patch("app.routers.assets.task_generate_one_pager.delay") as delay_mock,
    ):
        resp = await client.post(f"{API}/books/book-001/assets/one-pager", json={
            "bookId": "book-001",
        })
    assert resp.status_code == 202
    assert resp.json()["job_id"] == job["id"]
    delay_mock.assert_called_once()


@pytest.mark.asyncio
async def test_generate_one_pager_sync_opt_in_skips_celery(client):
    book = fake_book({"status": "generated"})
    job  = fake_job("one_pager_generation")
    new_asset = fake_asset({"status": "pending"})
    with (
        patch("app.routers.assets.books_repo.get",         new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.assets_repo.list",       new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.create",     new_callable=AsyncMock, return_value=new_asset),
        patch("app.routers.assets.jobs_repo.create_job",   new_callable=AsyncMock, return_value=job),
        patch("app.routers.assets.task_generate_one_pager.delay") as delay_mock,
        patch("app.routers.assets.generate_one_pager_now",
              new_callable=AsyncMock, return_value="https://storage.example.com/one-pager.pdf") as sync_fn,
    ):
        resp = await client.post(f"{API}/books/book-001/assets/one-pager", json={
            "bookId": "book-001",
            "sync": True,
        })
    assert resp.status_code == 202
    assert resp.json()["job_id"] == job["id"]
    sync_fn.assert_awaited_once()
    delay_mock.assert_not_called()


@pytest.mark.asyncio
async def test_generate_one_pager_falls_back_to_sync_when_celery_unavailable(client):
    book = fake_book({"status": "generated"})
    job  = fake_job("one_pager_generation")
    new_asset = fake_asset({"status": "pending"})
    with (
        patch("app.routers.assets.books_repo.get",         new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.assets_repo.list",       new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.create",     new_callable=AsyncMock, return_value=new_asset),
        patch("app.routers.assets.jobs_repo.create_job",   new_callable=AsyncMock, return_value=job),
        patch("app.routers.assets.task_generate_one_pager.delay",
              side_effect=ConnectionError("Redis unreachable")),
        patch("app.routers.assets.generate_one_pager_now",
              new_callable=AsyncMock, return_value="https://storage.example.com/one-pager.pdf") as generate,
    ):
        resp = await client.post(f"{API}/books/book-001/assets/one-pager", json={
            "bookId": "book-001",
        })
    assert resp.status_code == 202
    assert resp.json()["job_id"] == job["id"]
    generate.assert_awaited_once()


@pytest.mark.asyncio
async def test_regenerating_one_pager_reuses_same_asset_doc_not_duplicate(client):
    """Calling the generate endpoint twice for the same (book, type) must
    result in ONE asset document — same id, content/title updated — not
    two separate documents accumulating in the library."""
    book = fake_book({"status": "generated"})
    store: dict = {}

    async def fake_create(data):
        doc_id = f"asset-{len(store) + 1}"
        doc = {**data, "id": doc_id, "createdAt": "t", "updatedAt": "t"}
        store[doc_id] = doc
        return doc

    async def fake_update(doc_id, data):
        store[doc_id] = {**store[doc_id], **data}
        return store[doc_id]

    async def fake_list(filters=None, **kwargs):
        book_id = next((v for f, _op, v in filters if f == "bookId"), None)
        asset_type = next((v for f, _op, v in filters if f == "type"), None)
        matches = [d for d in store.values() if d.get("bookId") == book_id and d.get("type") == asset_type]
        return matches[: kwargs.get("limit", len(matches))]

    with (
        patch("app.routers.assets.books_repo.get", new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.assets_repo.create", side_effect=fake_create),
        patch("app.routers.assets.assets_repo.update", side_effect=fake_update),
        patch("app.routers.assets.assets_repo.list", side_effect=fake_list),
        patch("app.routers.assets.jobs_repo.create_job",
              new_callable=AsyncMock, return_value=fake_job("one_pager_generation")),
        patch("app.routers.assets.task_generate_one_pager.delay", return_value=None),
    ):
        resp1 = await client.post(f"{API}/books/book-001/assets/one-pager", json={"bookId": "book-001"})
        resp2 = await client.post(f"{API}/books/book-001/assets/one-pager", json={"bookId": "book-001"})

    assert resp1.status_code == 202
    assert resp2.status_code == 202
    one_pager_docs = [d for d in store.values() if d.get("type") == "one_pager"]
    assert len(one_pager_docs) == 1
    assert one_pager_docs[0]["title"] == f"One-Pager — {book['title']}"


@pytest.mark.asyncio
async def test_generate_one_pager_failure_fails_job(client):
    """If generation fallback fails, the job must be marked failed and the asset
    marked errored — not silently swallowed."""
    book = fake_book({"status": "generated"})
    job  = fake_job("one_pager_generation")
    new_asset = fake_asset({"status": "pending", "id": "asset-001"})
    with (
        patch("app.routers.assets.books_repo.get",         new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.assets_repo.list",       new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.create",     new_callable=AsyncMock, return_value=new_asset),
        patch("app.routers.assets.assets_repo.update",     new_callable=AsyncMock, return_value=None) as assets_update,
        patch("app.routers.assets.jobs_repo.create_job",   new_callable=AsyncMock, return_value=job),
        patch("app.routers.assets.jobs_repo.fail_job",     new_callable=AsyncMock, return_value=None) as fail_job,
        patch("app.routers.assets.task_generate_one_pager.delay",
              side_effect=ConnectionError("Redis unreachable")),
        patch("app.routers.assets.generate_one_pager_now",
              new_callable=AsyncMock, side_effect=RuntimeError("DeepSeek timeout")),
    ):
        with pytest.raises(RuntimeError, match="DeepSeek timeout"):
            await client.post(f"{API}/books/book-001/assets/one-pager", json={
                "bookId": "book-001",
            })
    fail_job.assert_awaited_once_with(job["id"], "DeepSeek timeout")
    assets_update.assert_awaited_once_with("asset-001", {"status": "error"})


@pytest.mark.asyncio
async def test_generate_whitepaper_enqueues_celery_task(client):
    book = fake_book({"status": "generated"})
    job  = fake_job("whitepaper_generation")
    new_asset = fake_asset({"type": "whitepaper", "status": "pending"})
    with (
        patch("app.routers.assets.books_repo.get",         new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.books_repo.get_chapters", new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.list",       new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.create",     new_callable=AsyncMock, return_value=new_asset),
        patch("app.routers.assets.jobs_repo.create_job",   new_callable=AsyncMock, return_value=job),
        patch("app.routers.assets.task_generate_whitepaper.delay") as delay_mock,
    ):
        resp = await client.post(f"{API}/books/book-001/assets/whitepaper", json={
            "bookId": "book-001",
        })
    assert resp.status_code == 202
    assert resp.json()["job_id"] == job["id"]
    delay_mock.assert_called_once()


@pytest.mark.asyncio
async def test_generate_social_posts_enqueues_celery_task(client):
    book = fake_book({"status": "generated"})
    job  = fake_job("social_posts_generation")
    new_asset = fake_asset({"type": "social_post", "status": "pending"})
    with (
        patch("app.routers.assets.books_repo.get",         new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.assets_repo.list",       new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.create",     new_callable=AsyncMock, return_value=new_asset),
        patch("app.routers.assets.jobs_repo.create_job",   new_callable=AsyncMock, return_value=job),
        patch("app.routers.assets.task_generate_social_posts.delay") as delay_mock,
    ):
        resp = await client.post(f"{API}/books/book-001/assets/social-posts", json={
            "bookId": "book-001",
            "platforms": ["linkedin", "twitter"]
        })
    assert resp.status_code == 202
    assert "job_id" in resp.json()
    delay_mock.assert_called_once()


@pytest.mark.asyncio
async def test_generate_social_posts_falls_back_to_sync_when_celery_unavailable(client):
    book = fake_book({"status": "generated"})
    job  = fake_job("social_posts_generation")
    new_asset = fake_asset({"type": "social_post", "status": "pending"})
    with (
        patch("app.routers.assets.books_repo.get",         new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.assets_repo.list",       new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.create",     new_callable=AsyncMock, return_value=new_asset),
        patch("app.routers.assets.jobs_repo.create_job",   new_callable=AsyncMock, return_value=job),
        patch("app.routers.assets.task_generate_social_posts.delay",
              side_effect=ConnectionError("Redis unreachable")),
        patch("app.routers.assets.generate_social_posts_now",
              new_callable=AsyncMock, return_value=[{"platform": "linkedin", "content": "..."}]) as generate,
    ):
        resp = await client.post(f"{API}/books/book-001/assets/social-posts", json={
            "bookId": "book-001",
            "platforms": ["linkedin", "twitter"]
        })
    assert resp.status_code == 202
    assert "job_id" in resp.json()
    generate.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_social_posts_failure_fails_job(client):
    """If generation fails, the job must be marked failed and the asset
    marked errored — not silently swallowed."""
    book = fake_book({"status": "generated"})
    job  = fake_job("social_posts_generation")
    new_asset = fake_asset({"type": "social_post", "status": "pending", "id": "asset-001"})
    with (
        patch("app.routers.assets.books_repo.get",         new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.assets_repo.list",       new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.create",     new_callable=AsyncMock, return_value=new_asset),
        patch("app.routers.assets.assets_repo.update",     new_callable=AsyncMock, return_value=None) as assets_update,
        patch("app.routers.assets.jobs_repo.create_job",   new_callable=AsyncMock, return_value=job),
        patch("app.routers.assets.jobs_repo.fail_job",     new_callable=AsyncMock, return_value=None) as fail_job,
        patch("app.routers.assets.task_generate_social_posts.delay",
              side_effect=ConnectionError("Redis unreachable")),
        patch("app.routers.assets.generate_social_posts_now",
              new_callable=AsyncMock, side_effect=RuntimeError("DeepSeek timeout")),
    ):
        with pytest.raises(RuntimeError, match="DeepSeek timeout"):
            await client.post(f"{API}/books/book-001/assets/social-posts", json={
                "bookId": "book-001",
                "platforms": ["linkedin"]
            })
    fail_job.assert_awaited_once_with(job["id"], "DeepSeek timeout")
    assets_update.assert_awaited_once_with("asset-001", {"status": "error"})


@pytest.mark.asyncio
async def test_generate_infographic_enqueues_celery_task(client):
    book = fake_book({"status": "generated"})
    job  = fake_job("infographic_generation")
    new_asset = fake_asset({"type": "infographic", "status": "pending"})
    with (
        patch("app.routers.assets.books_repo.get",         new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.assets_repo.list",       new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.create",     new_callable=AsyncMock, return_value=new_asset),
        patch("app.routers.assets.jobs_repo.create_job",   new_callable=AsyncMock, return_value=job),
        patch("app.routers.assets.task_generate_infographic.delay") as delay_mock,
    ):
        resp = await client.post(f"{API}/books/book-001/assets/infographic", json={
            "bookId": "book-001",
        })
    assert resp.status_code == 202
    assert resp.json()["job_id"] == job["id"]
    delay_mock.assert_called_once()


@pytest.mark.asyncio
async def test_generate_infographic_falls_back_to_sync_when_celery_unavailable(client):
    book = fake_book({"status": "generated"})
    job  = fake_job("infographic_generation")
    new_asset = fake_asset({"type": "infographic", "status": "pending"})
    with (
        patch("app.routers.assets.books_repo.get",         new_callable=AsyncMock, return_value=book),
        patch("app.routers.assets.assets_repo.list",       new_callable=AsyncMock, return_value=[]),
        patch("app.routers.assets.assets_repo.create",     new_callable=AsyncMock, return_value=new_asset),
        patch("app.routers.assets.jobs_repo.create_job",   new_callable=AsyncMock, return_value=job),
        patch("app.routers.assets.task_generate_infographic.delay",
              side_effect=ConnectionError("Redis unreachable")),
        patch("app.routers.assets.generate_infographic_now",
              new_callable=AsyncMock, return_value={"title": "..."}) as generate,
    ):
        resp = await client.post(f"{API}/books/book-001/assets/infographic", json={
            "bookId": "book-001",
        })
    assert resp.status_code == 202
    assert resp.json()["job_id"] == job["id"]
    generate.assert_awaited_once()

