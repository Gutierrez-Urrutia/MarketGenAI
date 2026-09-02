from fastapi import APIRouter, Depends

from app.dependencies.auth import CurrentUser, get_current_user

router = APIRouter(
    prefix="/settings/social",
    tags=["Social Integrations"]
)


@router.post("/{platform}/connect")
async def connect_social(platform: str, user: CurrentUser = Depends(get_current_user)):

    return {
        "platform": platform,
        "authUrl": f"https://oauth.example.com/{platform}"
    }


@router.delete("/{platform}")
async def disconnect_social(platform: str, user: CurrentUser = Depends(get_current_user)):

    return {
        "platform": platform,
        "disconnected": True
    }