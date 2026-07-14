from typing import Any

from fastapi import HTTPException, status

ROLES_HIERARCHY = {
    "admin": ["admin", "manager", "user"],
    "manager": ["manager", "user"],
    "user": ["user"],
}


def _roles(current_user: Any) -> list[str]:
    if isinstance(current_user, dict):
        return current_user.get("roles", ["user"])
    return getattr(current_user, "roles", None) or ["user"]


def require_role(required_role: str):
    """Dependency factory para requerir un rol minimo."""
    def check_role(current_user: Any):
        user_roles = _roles(current_user)
        granted = set()
        for role in user_roles:
            granted.update(ROLES_HIERARCHY.get(role, [role]))
        if required_role not in granted:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Insufficient permissions. Required role: {required_role}",
            )
        return current_user

    return check_role


def is_admin(current_user: Any) -> bool:
    return "admin" in _roles(current_user)


def is_manager(current_user: Any) -> bool:
    return any(r in ["admin", "manager"] for r in _roles(current_user))
