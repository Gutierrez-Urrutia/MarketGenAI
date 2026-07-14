from __future__ import annotations

from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.services.auth_service import hash_token, refresh_expires_at


@pytest.mark.asyncio
async def test_refresh_contract_rotates_tokens_and_authorizes_next_request(app):
    refresh_token = "existing-refresh-token"
    user = {
        "id": "refresh-user-123",
        "email": "user@example.com",
        "name": "Refresh User",
        "passwordHash": "unused",
        "roles": ["user"],
        "status": "active",
    }
    stored_token = {
        "userId": user["id"],
        "expiresAt": refresh_expires_at() + timedelta(minutes=1),
        "revokedAt": None,
    }
    original_overrides = app.dependency_overrides.copy()
    app.dependency_overrides.clear()

    try:
        with (
            patch(
                "app.routers.auth.refresh_tokens_repo.get",
                AsyncMock(return_value=stored_token),
            ) as get_refresh_token,
            patch(
                "app.routers.auth.refresh_tokens_repo.revoke",
                AsyncMock(),
            ) as revoke_refresh_token,
            patch(
                "app.routers.auth.refresh_tokens_repo.create_token",
                AsyncMock(),
            ) as create_refresh_token,
            patch(
                "app.routers.auth.users_repo.get",
                AsyncMock(return_value=user),
            ),
            patch(
                "app.routers.auth.users_repo.touch_login",
                AsyncMock(),
            ),
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://testserver",
            ) as client:
                refresh = await client.post(
                    "/api/v1/auth/refresh",
                    json={"refreshToken": refresh_token},
                )

                assert refresh.status_code == 200
                session = refresh.json()
                assert session["accessToken"]
                assert session["refreshToken"]
                assert session["refreshToken"] != refresh_token

                authenticated = await client.get(
                    "/api/v1/auth/me",
                    headers={"Authorization": f"Bearer {session['accessToken']}"},
                )

        token_hash = hash_token(refresh_token)
        get_refresh_token.assert_awaited_once_with(token_hash)
        revoke_refresh_token.assert_awaited_once_with(token_hash)
        create_refresh_token.assert_awaited_once()
        assert authenticated.status_code == 200
        assert authenticated.json()["id"] == user["id"]
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(original_overrides)
