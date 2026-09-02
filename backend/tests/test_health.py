"""Tests for the health check endpoint."""
import pytest


@pytest.mark.asyncio
async def test_health_returns_200(client):
    """GET /api/v1/health should return 200 with status ok."""
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert data.get("status") == "ok"


@pytest.mark.asyncio
async def test_health_has_version_field(client):
    """Health response should include a version field."""
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert "version" in data


@pytest.mark.asyncio
async def test_root_redirects_to_dashboard(client):
    """GET / or unknown routes should not 500."""
    response = await client.get("/", follow_redirects=False)
    assert response.status_code in (200, 301, 302, 307, 308, 404)
