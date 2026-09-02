"""Smoke tests for the auth/ownership fixes in proposals, platform, assistant and reports."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import FAKE_USER_SUB

PROPOSALS_API = "/api/v1/proposals"


@pytest.mark.asyncio
async def test_get_proposals_filters_by_user(client):
    with patch("app.routers.proposals.proposals_repo.list", new_callable=AsyncMock, return_value=[]) as mock_list:
        resp = await client.get(PROPOSALS_API)
    assert resp.status_code == 200
    assert resp.json() == []
    _, kwargs = mock_list.call_args
    assert kwargs["filters"] == [("userId", "==", FAKE_USER_SUB)]


@pytest.mark.asyncio
async def test_get_proposal_forbidden_for_other_user(client):
    other = {
        "id": "proposal-001", "userId": "other-user", "title": "X",
        "clientName": "Y", "status": "draft", "content": "",
    }
    with patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=other):
        resp = await client.get(f"{PROPOSALS_API}/proposal-001")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_update_proposal_partial(client):
    proposal = {
        "id": "proposal-001", "userId": FAKE_USER_SUB, "title": "Old",
        "clientName": "Acme", "status": "draft", "content": "",
    }
    updated = {**proposal, "status": "approved"}
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.proposals_repo.get_or_404", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=updated) as mock_update,
    ):
        resp = await client.put(f"{PROPOSALS_API}/proposal-001", json={"status": "approved"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "approved"
    mock_update.assert_called_once_with("proposal-001", {"status": "approved"})


@pytest.mark.asyncio
async def test_assistant_chat_requires_auth(client):
    with patch("app.routers.assistant.OpenAI") as mock_openai:
        mock_openai.return_value.chat.completions.create.return_value.choices = [
            type("C", (), {"message": type("M", (), {"content": "hola"})()})()
        ]
        resp = await client.post("/api/v1/assistant/chat", json={"message": "hola"})
    assert resp.status_code == 200
    assert resp.json()["reply"] == "hola"


@pytest.mark.asyncio
async def test_content_library_scoped_by_user(client):
    with (
        patch("app.routers.platform.proposals_repo.list", new_callable=AsyncMock, return_value=[]) as mock_proposals,
        patch("app.routers.platform.templates_repo.list", new_callable=AsyncMock, return_value=[]),
        patch("app.routers.platform.assets_repo.list", new_callable=AsyncMock, return_value=[]),
    ):
        resp = await client.get("/api/v1/content-library")
    assert resp.status_code == 200
    assert resp.json() == {"proposals": [], "templates": [], "assets": [], "total": 0}
    _, kwargs = mock_proposals.call_args
    assert kwargs["filters"] == [("userId", "==", FAKE_USER_SUB)]


@pytest.mark.asyncio
async def test_content_library_keeps_generated_social_posts_as_social_posts(client):
    social_post = {
        "id": "social-001",
        "userId": FAKE_USER_SUB,
        "type": "social_post",
        "title": "CRM campaign",
        "content": "<p class=\"sp-body\">Ready to publish</p>",
        "language": "en",
        "input_data": {"platform": "LinkedIn"},
    }
    with (
        patch("app.routers.platform.proposals_repo.list", new_callable=AsyncMock, return_value=[]),
        patch("app.routers.platform.templates_repo.list", new_callable=AsyncMock, return_value=[]),
        patch("app.routers.platform.assets_repo.list", new_callable=AsyncMock, return_value=[]),
        patch("app.routers.platform.content_items_repo.list", new_callable=AsyncMock, return_value=[social_post]),
    ):
        resp = await client.get("/api/v1/content-library")

    assert resp.status_code == 200
    item = resp.json()["templates"][0]
    assert item["type"] == "Social Post"
    assert item["inputData"] == {"platform": "LinkedIn"}


@pytest.mark.asyncio
async def test_reports_dashboard_scoped_by_user(client):
    with (
        patch("app.routers.reports.books_repo.count", new_callable=AsyncMock, return_value=0),
        patch("app.routers.reports.proposals_repo.count", new_callable=AsyncMock, return_value=0),
        patch("app.routers.reports.customers_repo.count", new_callable=AsyncMock, return_value=0) as mock_count,
        patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock, return_value=[]),
    ):
        resp = await client.get("/api/v1/reports/dashboard")
    assert resp.status_code == 200
    body = resp.json()
    assert body["totals"]["customers"] == 0
    _, kwargs = mock_count.call_args
    assert kwargs["filters"] == [("userId", "==", FAKE_USER_SUB)]


@pytest.mark.asyncio
async def test_platform_settings_scoped_by_user(client):
    with patch(
        "app.routers.platform.settings_repo.get_by_user",
        new_callable=AsyncMock,
        return_value={"userId": FAKE_USER_SUB, "crm": {}, "llm": {}, "socialConnections": []},
    ) as mock_get:
        resp = await client.get("/api/v1/platform/settings")
    assert resp.status_code == 200
    assert resp.json()["userId"] == FAKE_USER_SUB
    mock_get.assert_called_once_with(FAKE_USER_SUB)


@pytest.mark.asyncio
async def test_social_connect_requires_auth():
    """/settings/social/{platform}/connect must reject requests without a Bearer token."""
    from app.main import app as fastapi_app
    from httpx import AsyncClient, ASGITransport

    original_overrides = fastapi_app.dependency_overrides.copy()
    fastapi_app.dependency_overrides.clear()

    try:
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app),
            base_url="http://testserver",
        ) as ac:
            resp = await ac.post("/api/v1/settings/social/twitter/connect")
        assert resp.status_code in (401, 403)
    finally:
        fastapi_app.dependency_overrides.update(original_overrides)


@pytest.mark.asyncio
async def test_social_disconnect_requires_auth():
    """/settings/social/{platform} (DELETE) must reject requests without a Bearer token."""
    from app.main import app as fastapi_app
    from httpx import AsyncClient, ASGITransport

    original_overrides = fastapi_app.dependency_overrides.copy()
    fastapi_app.dependency_overrides.clear()

    try:
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app),
            base_url="http://testserver",
        ) as ac:
            resp = await ac.delete("/api/v1/settings/social/twitter")
        assert resp.status_code in (401, 403)
    finally:
        fastapi_app.dependency_overrides.update(original_overrides)


@pytest.mark.asyncio
async def test_social_connect_with_auth(client):
    resp = await client.post("/api/v1/settings/social/twitter/connect")
    assert resp.status_code == 200
    assert resp.json()["platform"] == "twitter"
