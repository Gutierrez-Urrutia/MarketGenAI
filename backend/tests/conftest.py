"""
pytest configuration and shared fixtures for the NoonDalton backend test suite.

Strategy:
  - All external services (Firestore, Keycloak, Supabase) are mocked.
  - The FastAPI app is tested via httpx.AsyncClient with a dependency override
    for `get_current_user`, so no real JWT is required.
  - Async tests use pytest-asyncio in "auto" mode.
"""
from __future__ import annotations

import asyncio
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

# ── Tell pytest-asyncio to use auto mode ──────────────────────────────────────
pytest_plugins = ["pytest_asyncio"]


# ── Fake user ─────────────────────────────────────────────────────────────────
FAKE_USER_SUB   = "test-user-sub-123"
FAKE_USER_EMAIL = "test@noondalton.com"


def _fake_current_user():
    """Return a minimal CurrentUser that passes ownership checks."""
    from app.dependencies.auth import CurrentUser
    return CurrentUser(
        sub=FAKE_USER_SUB,
        email=FAKE_USER_EMAIL,
        name="Test User",
        preferred_username="testuser",
        roles=["nd-user"],
        raw={"sub": FAKE_USER_SUB},
    )


# ── App fixture ───────────────────────────────────────────────────────────────
@pytest_asyncio.fixture(scope="session")
async def app():
    """
    Create the FastAPI app with all external dependencies patched out.

    Patches applied for the whole test session:
      - Firestore client (google-cloud-firestore)
      - Supabase / storage3 clients
      - Keycloak JWKS fetch (not needed; auth dependency overridden)
    """
    with (
        patch("google.cloud.firestore.AsyncClient", MagicMock()),
        patch("supabase.create_client", MagicMock()),
    ):
        from app.main import app as fastapi_app
        from app.dependencies.auth import get_current_user

        # Override auth so every test request is pre-authenticated
        fastapi_app.dependency_overrides[get_current_user] = _fake_current_user

        yield fastapi_app

        fastapi_app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client(app) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client backed by the patched FastAPI app."""
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as ac:
        yield ac


# ── Helper: build a fake Firestore repo response ──────────────────────────────
def fake_book(overrides: dict | None = None) -> dict:
    base = {
        "id":           "book-001",
        "userId":       FAKE_USER_SUB,
        "title":        "Test Book",
        "description":  "A test book description.",
        "status":       "draft",
        "keywords":     ["ai", "marketing"],
        "writingStyle": "professional",
        "contentType":  "long",
        "chapterCount": 5,
        "createdAt":    "2024-01-01T00:00:00Z",
        "updatedAt":    "2024-01-01T00:00:00Z",
    }
    if overrides:
        base.update(overrides)
    return base


def fake_chapter(overrides: dict | None = None) -> dict:
    base = {
        "id":               "chapter-001",
        "bookId":           "book-001",
        "title":            "Chapter 1",
        "description":      "Introduction chapter.",
        "orderIndex":       0,
        "status":           "generated",
        "content":          "<p>Chapter content here.</p>",
        "wordCount":        100,
        "contentAvailable": True,
    }
    if overrides:
        base.update(overrides)
    return base


def fake_job(job_type: str = "test_job") -> dict:
    return {
        "id":         "job-001",
        "type":       job_type,
        "userId":     FAKE_USER_SUB,
        "status":     "pending",
        "progress":   0,
        "result":     None,
        "error":      None,
        "createdAt":  "2024-01-01T00:00:00Z",
        "updatedAt":  "2024-01-01T00:00:00Z",
    }
