"""
Tests for the Keycloak JWT authentication dependency.

These tests exercise the token verification logic in isolation, without
spinning up a real Keycloak instance.
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials


# ── Helper: minimal RSA-style JWT (not cryptographically valid, just structure) ─

FAKE_PAYLOAD = {
    "sub":                "user-abc-123",
    "email":              "user@example.com",
    "name":               "Test User",
    "preferred_username": "testuser",
    "realm_access":       {"roles": ["nd-user"]},
    "exp":                int(time.time()) + 3600,
    "iss":                "https://keycloak.example.com/realms/noondalton",
}

# ── Unit tests for access-token verification ──────────────────────────────────

@pytest.mark.asyncio
async def test_verify_token_decodes_access_token():
    """verify_token should decode a valid access token into CurrentUser."""
    import app.dependencies.auth as auth_mod

    payload = {**FAKE_PAYLOAD, "typ": "access", "roles": ["nd-user"]}
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="token")
    with patch("app.dependencies.auth.jwt.decode", return_value=payload) as decode:
        result = await auth_mod.verify_token(credentials)

    assert result.sub == FAKE_PAYLOAD["sub"]
    assert result.email == FAKE_PAYLOAD["email"]
    assert result.roles == ["nd-user"]
    decode.assert_called_once()


@pytest.mark.asyncio
async def test_verify_token_rejects_non_access_token():
    """verify_token should reject refresh or otherwise non-access tokens."""
    import app.dependencies.auth as auth_mod

    payload = {**FAKE_PAYLOAD, "typ": "refresh", "roles": ["nd-user"]}
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="token")
    with patch("app.dependencies.auth.jwt.decode", return_value=payload):
        with pytest.raises(HTTPException) as exc_info:
            await auth_mod.verify_token(credentials)

    assert exc_info.value.status_code == 401


# ── Unit tests for CurrentUser model ─────────────────────────────────────────

def test_current_user_defaults():
    """CurrentUser should have sensible defaults for optional fields."""
    from app.dependencies.auth import CurrentUser
    user = CurrentUser(sub="sub-123")
    assert user.sub == "sub-123"
    assert user.email is None
    assert user.roles == []
    assert user.raw == {}


def test_current_user_roles_populated():
    """CurrentUser.roles should contain the parsed Keycloak realm roles."""
    from app.dependencies.auth import CurrentUser
    user = CurrentUser(
        sub="sub-123",
        roles=["nd-user", "nd-admin"],
        raw=FAKE_PAYLOAD,
    )
    assert "nd-admin" in user.roles


# ── Unit tests for require_roles guard ────────────────────────────────────────

@pytest.mark.asyncio
async def test_require_roles_passes_with_correct_role():
    """require_roles should return the user when they have the required role."""
    from app.dependencies.auth import require_roles, CurrentUser

    user_with_role = CurrentUser(sub="sub", roles=["nd-admin"])
    guard = require_roles("nd-admin")

    result = await guard(current_user=user_with_role)
    assert result.sub == "sub"


@pytest.mark.asyncio
async def test_require_roles_raises_403_without_role():
    """require_roles should raise 403 when the user lacks the required role."""
    from app.dependencies.auth import require_roles, CurrentUser

    user_without_role = CurrentUser(sub="sub", roles=["nd-user"])
    guard = require_roles("nd-admin")

    with pytest.raises(HTTPException) as exc_info:
        await guard(current_user=user_without_role)
    assert exc_info.value.status_code == 403


# ── Integration: unauthenticated request is rejected ─────────────────────────

@pytest.mark.asyncio
async def test_protected_endpoint_requires_auth():
    """
    A request to a protected endpoint without a Bearer token should receive 403.

    Note: the shared `client` fixture already has auth overridden.
    We create a clean client here to test the real auth path.
    """
    import app.dependencies.auth as auth_mod
    from app.main import app as fastapi_app
    from httpx import AsyncClient, ASGITransport

    # Remove the test override to expose the real auth guard
    original_overrides = fastapi_app.dependency_overrides.copy()
    fastapi_app.dependency_overrides.clear()

    try:
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app),
            base_url="http://testserver",
        ) as ac:
            resp = await ac.get("/api/v1/books")
        # Without a Bearer token, HTTPBearer returns 403
        assert resp.status_code in (401, 403)
    finally:
        fastapi_app.dependency_overrides.update(original_overrides)
