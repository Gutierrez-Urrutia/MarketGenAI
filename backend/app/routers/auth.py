"""Authentication router backed by Firestore users."""

import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status, Body
from fastapi.responses import Response
from google.auth.exceptions import DefaultCredentialsError

from app.config import settings
from app.core.rate_limit import limiter
from app.core.rbac import require_role
from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.auth import (
    ForgotPasswordRequest,
    LoginRequest,
    LoginResponse,
    LogoutRequest,
    MessageResponse,
    RefreshRequest,
    RefreshResponse,
    RegisterRequest,
    ResetPasswordRequest,
    UserInfo,
)
from app.services.auth_service import (
    create_access_token,
    hash_password,
    hash_token,
    new_opaque_token,
    public_user,
    refresh_expires_at,
    reset_expires_at,
    utc_now,
    verify_password,
)
from app.services.firestore_service import (
    password_reset_tokens_repo,
    refresh_tokens_repo,
    users_repo,
)

router = APIRouter(prefix="/auth", tags=["Authentication"])

_local_refresh_sessions: dict[str, dict] = {}


def _is_expired(value) -> bool:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) <= utc_now()
    return True


async def _issue_session(user: dict) -> LoginResponse:
    access_token = create_access_token(user)
    refresh_token = new_opaque_token()
    await refresh_tokens_repo.create_token(
        hash_token(refresh_token),
        {
            "userId": user["id"],
            "expiresAt": refresh_expires_at(),
            "revokedAt": None,
        },
    )
    await users_repo.touch_login(user["id"])
    public = public_user(user)
    return LoginResponse(
        accessToken=access_token,
        refreshToken=refresh_token,
        expiresIn=settings.access_token_expire_minutes * 60,
        user=UserInfo(**public),
    )


def _local_dev_auth_is_enabled() -> bool:
    return settings.local_dev_auth_enabled and settings.app_env.lower() != "production"


def _local_dev_user() -> dict:
    return {
        "id": "local-dev-admin",
        "email": settings.local_dev_auth_email.lower(),
        "name": settings.local_dev_auth_name,
        "roles": ["admin", "user"],
        "status": "active",
    }


def _authenticate_local_dev_user(username_or_email: str, password: str) -> dict | None:
    if not _local_dev_auth_is_enabled():
        return None
    email_matches = username_or_email.lower() == settings.local_dev_auth_email.lower()
    password_matches = secrets.compare_digest(password, settings.local_dev_auth_password)
    return _local_dev_user() if email_matches and password_matches else None


async def _issue_local_dev_session(user: dict) -> LoginResponse:
    access_token = create_access_token(user)
    refresh_token = new_opaque_token()
    _local_refresh_sessions[hash_token(refresh_token)] = {
        "user": user,
        "expiresAt": refresh_expires_at(),
    }
    return LoginResponse(
        accessToken=access_token,
        refreshToken=refresh_token,
        expiresIn=settings.access_token_expire_minutes * 60,
        user=UserInfo(**public_user(user)),
    )


def _local_current_user_info(current_user: CurrentUser) -> UserInfo:
    roles = current_user.roles or ["admin", "user"]
    return UserInfo(
        id=current_user.sub,
        email=current_user.email or settings.local_dev_auth_email.lower(),
        name=current_user.name or settings.local_dev_auth_name,
        role=roles[0] if roles else "admin",
        roles=roles,
    )


@router.post("/register", response_model=LoginResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def register(request: Request, body: RegisterRequest = Body(...)) -> LoginResponse:
    email = body.email.lower()
    existing = await users_repo.get_by_email(email)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "EMAIL_ALREADY_REGISTERED", "message": "El email ya esta registrado."},
        )

    user = await users_repo.create_user(
        {
            "email": email,
            "name": body.name,
            "passwordHash": hash_password(body.password),
            "roles": ["user"],
            "status": "active",
        }
    )
    return await _issue_session(user)


@router.post("/login", response_model=LoginResponse, status_code=status.HTTP_200_OK)
@limiter.limit("10/minute")
async def login(request: Request, body: LoginRequest = Body(...)) -> LoginResponse:
    local_user = _authenticate_local_dev_user(body.usernameOrEmail, body.password)
    if local_user:
        return await _issue_local_dev_session(local_user)

    try:
        user = await users_repo.get_by_email(body.usernameOrEmail.lower())
    except DefaultCredentialsError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "FIRESTORE_CREDENTIALS_MISSING",
                "message": (
                    "Firestore credentials are missing. Configure Firebase credentials "
                    "or use the local development login."
                ),
            },
        ) from exc
    if not user or not verify_password(body.password, user.get("passwordHash", "")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_CREDENTIALS", "message": "Email o contrasena incorrectos."},
        )
    if user.get("status") != "active":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "ACCOUNT_DISABLED", "message": "La cuenta esta deshabilitada."},
        )
    return await _issue_session(user)


@router.post("/refresh", response_model=RefreshResponse, status_code=status.HTTP_200_OK)
async def refresh_token(body: RefreshRequest) -> RefreshResponse:
    token_hash = hash_token(body.refreshToken)
    local_session = _local_refresh_sessions.get(token_hash)
    if _local_dev_auth_is_enabled() and local_session:
        if _is_expired(local_session.get("expiresAt")):
            _local_refresh_sessions.pop(token_hash, None)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": "TOKEN_EXPIRED_OR_REVOKED", "message": "Refresh token invalido o expirado."},
            )
        _local_refresh_sessions.pop(token_hash, None)
        new_session = await _issue_local_dev_session(local_session["user"])
        return RefreshResponse(
            accessToken=new_session.accessToken,
            expiresIn=new_session.expiresIn,
            refreshToken=new_session.refreshToken,
        )

    stored = await refresh_tokens_repo.get(token_hash)
    if not stored or stored.get("revokedAt") or _is_expired(stored.get("expiresAt")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "TOKEN_EXPIRED_OR_REVOKED", "message": "Refresh token invalido o expirado."},
        )

    user = await users_repo.get(stored["userId"])
    if not user or user.get("status") != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User unavailable.")

    await refresh_tokens_repo.revoke(token_hash)
    new_session = await _issue_session(user)
    return RefreshResponse(
        accessToken=new_session.accessToken,
        expiresIn=new_session.expiresIn,
        refreshToken=new_session.refreshToken,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    body: LogoutRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> Response:
    token_hash = hash_token(body.refreshToken)
    if _local_dev_auth_is_enabled() and token_hash in _local_refresh_sessions:
        _local_refresh_sessions.pop(token_hash, None)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    try:
        stored = await refresh_tokens_repo.get(token_hash)
    except DefaultCredentialsError:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if stored and stored.get("userId") == current_user.sub and not stored.get("revokedAt"):
        await refresh_tokens_repo.revoke(token_hash)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch("/users/{user_id}/roles")
async def update_user_roles(
    user_id: str,
    body: dict,
    current_user: CurrentUser = Depends(get_current_user),
):
    require_role("admin")(current_user)

    new_roles = body.get("roles", [])
    valid_roles = {"admin", "manager", "user"}
    if not all(r in valid_roles for r in new_roles):
        raise HTTPException(status_code=400, detail="Invalid roles")

    await users_repo.update(user_id, {"roles": new_roles})
    return {"message": "Roles updated", "roles": new_roles}


@router.post("/forgot-password", response_model=MessageResponse, status_code=status.HTTP_200_OK)
async def forgot_password(body: ForgotPasswordRequest) -> MessageResponse:
    user = await users_repo.get_by_email(body.email.lower())
    if user:
        reset_token = new_opaque_token()
        await password_reset_tokens_repo.create_token(
            hash_token(reset_token),
            {
                "userId": user["id"],
                "expiresAt": reset_expires_at(),
                "usedAt": None,
            },
        )
        # MVP note: wire this token into email delivery before production.
    return MessageResponse(
        message="Si el email existe en el sistema, recibiras un enlace de reset en breve."
    )


@router.post("/reset-password", response_model=MessageResponse, status_code=status.HTTP_200_OK)
async def reset_password(body: ResetPasswordRequest) -> MessageResponse:
    token_hash = hash_token(body.token)
    stored = await password_reset_tokens_repo.get(token_hash)
    if not stored or stored.get("usedAt") or _is_expired(stored.get("expiresAt")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_TOKEN", "message": "Token invalido o expirado."},
        )

    user = await users_repo.get(stored["userId"])
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid token.")

    await users_repo.update(user["id"], {"passwordHash": hash_password(body.new_password)})
    await password_reset_tokens_repo.mark_used(token_hash)
    return MessageResponse(message="Contrasena actualizada correctamente.")


@router.get("/me", response_model=UserInfo, status_code=status.HTTP_200_OK)
async def me(current_user: CurrentUser = Depends(get_current_user)) -> UserInfo:
    if _local_dev_auth_is_enabled() and current_user.sub == "local-dev-admin":
        return _local_current_user_info(current_user)

    try:
        user = await users_repo.get(current_user.sub)
    except DefaultCredentialsError as exc:
        if _local_dev_auth_is_enabled() and current_user.sub == "local-dev-admin":
            return _local_current_user_info(current_user)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "FIRESTORE_CREDENTIALS_MISSING",
                "message": "Firestore credentials are missing.",
            },
        ) from exc
    if not user:
        if _local_dev_auth_is_enabled():
            return _local_current_user_info(current_user)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return UserInfo(**public_user(user))


@router.put("/me", response_model=UserInfo, status_code=status.HTTP_200_OK)
async def update_me(
    body: dict,
    current_user: CurrentUser = Depends(get_current_user),
) -> UserInfo:
    allowed = {}
    if isinstance(body.get("name"), str) and body["name"].strip():
        allowed["name"] = body["name"].strip()
    if not allowed:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="No fields to update.")
    user = await users_repo.update(current_user.sub, allowed)
    return UserInfo(**public_user(user))
