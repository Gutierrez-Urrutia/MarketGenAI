from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from google.auth.exceptions import DefaultCredentialsError
from httpx import ASGITransport, AsyncClient

from app.services.auth_service import hash_password


@pytest.mark.asyncio
async def test_login_contract_issues_tokens_and_authorizes_me(app):
    user = {
        "id": "login-user-123",
        "email": "user@example.com",
        "name": "Login User",
        "passwordHash": hash_password("correct-password"),
        "roles": ["user"],
        "status": "active",
    }
    original_overrides = app.dependency_overrides.copy()
    app.dependency_overrides.clear()

    try:
        with (
            patch(
                "app.routers.auth.users_repo.get_by_email",
                AsyncMock(return_value=user),
            ) as get_by_email,
            patch(
                "app.routers.auth.users_repo.get",
                AsyncMock(return_value=user),
            ),
            patch(
                "app.routers.auth.users_repo.touch_login",
                AsyncMock(),
            ),
            patch(
                "app.routers.auth.refresh_tokens_repo.create_token",
                AsyncMock(),
            ),
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://testserver",
            ) as client:
                unauthenticated = await client.get("/api/v1/auth/me")
                login = await client.post(
                    "/api/v1/auth/login",
                    json={
                        "usernameOrEmail": "USER@example.com",
                        "password": "correct-password",
                    },
                )

                assert login.status_code == 200
                session = login.json()
                assert session["accessToken"]
                assert session["refreshToken"]
                get_by_email.assert_awaited_once_with("user@example.com")

                authenticated = await client.get(
                    "/api/v1/auth/me",
                    headers={"Authorization": f"Bearer {session['accessToken']}"},
                )

        assert unauthenticated.status_code in (401, 403)
        assert authenticated.status_code == 200
        assert authenticated.json()["id"] == user["id"]
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(original_overrides)


@pytest.mark.asyncio
async def test_login_uses_local_dev_auth_when_firestore_credentials_are_missing(app):
    original_overrides = app.dependency_overrides.copy()
    app.dependency_overrides.clear()

    try:
        with patch(
            "app.routers.auth.users_repo.get_by_email",
            AsyncMock(side_effect=DefaultCredentialsError("missing adc")),
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://testserver",
            ) as client:
                login = await client.post(
                    "/api/v1/auth/login",
                    json={
                        "usernameOrEmail": "admin@noondalton.com",
                        "password": "admin123",
                    },
                )

                assert login.status_code == 200
                session = login.json()
                assert session["accessToken"]
                assert session["refreshToken"]
                assert session["user"]["id"] == "local-dev-admin"

                with patch(
                    "app.routers.auth.users_repo.get",
                    AsyncMock(side_effect=DefaultCredentialsError("missing adc")),
                ):
                    me = await client.get(
                        "/api/v1/auth/me",
                        headers={"Authorization": f"Bearer {session['accessToken']}"},
                    )

        assert me.status_code == 200
        assert me.json()["id"] == "local-dev-admin"
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(original_overrides)
