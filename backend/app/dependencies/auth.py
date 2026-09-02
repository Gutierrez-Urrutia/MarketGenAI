"""JWT authentication dependency for Firestore-backed MVP auth."""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pydantic import BaseModel, Field

from app.config import settings
from app.services.auth_service import JWT_ALGORITHM

http_bearer = HTTPBearer(auto_error=True)


class CurrentUser(BaseModel):
    sub: str
    email: Optional[str] = None
    name: Optional[str] = None
    preferred_username: Optional[str] = None
    roles: list[str] = Field(default_factory=list)
    raw: Dict[str, Any] = Field(default_factory=dict)


async def verify_token(
    credentials: HTTPAuthorizationCredentials = Security(http_bearer),
) -> CurrentUser:
    token = credentials.credentials
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload: Dict[str, Any] = jwt.decode(
            token,
            settings.app_secret_key,
            algorithms=[JWT_ALGORITHM],
        )
        if payload.get("typ") != "access":
            raise credentials_exception
        roles = payload.get("roles") or ["user"]
        return CurrentUser(
            sub=payload["sub"],
            email=payload.get("email"),
            name=payload.get("name"),
            preferred_username=payload.get("preferred_username"),
            roles=roles,
            raw=payload,
        )
    except JWTError as exc:
        raise credentials_exception from exc
    except KeyError as exc:
        raise credentials_exception from exc


def require_roles(*required_roles: str):
    async def _guard(
        current_user: CurrentUser = Depends(verify_token),
    ) -> CurrentUser:
        missing = [role for role in required_roles if role not in current_user.roles]
        if missing:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing required roles: {', '.join(missing)}.",
            )
        return current_user

    return _guard


get_current_user = verify_token
