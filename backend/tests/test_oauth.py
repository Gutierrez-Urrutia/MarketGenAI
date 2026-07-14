"""Focused tests for Google OAuth callback URL construction."""
from urllib.parse import parse_qs, urlparse

import pytest
from unittest.mock import AsyncMock
from starlette.requests import Request

from app.routers import oauth


def _request(host: str = "preview.example.com") -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "http",
            "path": "/api/v1/auth/google",
            "headers": [
                (b"host", b"internal.example.com"),
                (b"x-forwarded-proto", b"https"),
                (b"x-forwarded-host", host.encode()),
            ],
        }
    )


def test_google_callback_uses_request_host_as_fallback(monkeypatch):
    monkeypatch.setattr(oauth.settings, "google_redirect_uri", "")

    assert oauth._google_callback_url(_request()) == (
        "https://preview.example.com/api/v1/auth/google/callback"
    )


@pytest.mark.asyncio
async def test_google_auth_uses_configured_redirect_uri(monkeypatch, caplog):
    redirect_uri = "https://backend.example.com/api/v1/auth/google/callback"
    monkeypatch.setattr(oauth.settings, "google_oauth_client_id", "client-id")
    monkeypatch.setattr(oauth.settings, "google_redirect_uri", redirect_uri)

    response = await oauth.google_auth(_request())
    params = parse_qs(urlparse(response.headers["location"]).query)

    assert params["redirect_uri"] == [redirect_uri]
    assert f"Google OAuth redirect_uri: {redirect_uri}" in caplog.text


def test_oauth_error_redirects_to_frontend_callback(monkeypatch):
    monkeypatch.setattr(oauth.settings, "frontend_url", "https://frontend.example.com/")

    response = oauth._error_redirect("google_denied")

    assert response.headers["location"] == (
        "https://frontend.example.com/auth/callback?oauth_error=google_denied"
    )


@pytest.mark.asyncio
async def test_session_redirects_to_frontend_callback(monkeypatch):
    monkeypatch.setattr(oauth.settings, "frontend_url", "https://frontend.example.com")
    monkeypatch.setattr(oauth, "create_access_token", lambda user: "access-token")
    monkeypatch.setattr(oauth, "new_opaque_token", lambda: "refresh-token")
    monkeypatch.setattr(oauth, "hash_token", lambda token: "hashed-token")
    monkeypatch.setattr(oauth, "refresh_expires_at", lambda: "expires-at")
    monkeypatch.setattr(oauth, "public_user", lambda user: {"id": user["id"]})
    monkeypatch.setattr(oauth.refresh_tokens_repo, "create_token", AsyncMock())
    monkeypatch.setattr(oauth.users_repo, "touch_login", AsyncMock())

    response = await oauth._issue_session_and_redirect({"id": "user-1"})
    location = urlparse(response.headers["location"])
    params = parse_qs(location.query)

    assert f"{location.scheme}://{location.netloc}{location.path}" == (
        "https://frontend.example.com/auth/callback"
    )
    assert params["oauth_access_token"] == ["access-token"]
    assert params["oauth_refresh_token"] == ["refresh-token"]
