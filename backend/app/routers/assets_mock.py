from fastapi import APIRouter

router = APIRouter(
    prefix="/assets",
    tags=["Marketing Assets"]
)


@router.post("/images/generate")
async def generate_ai_image(payload: dict):

    return {
        "jobId": "img_job_123",
        "status": "pending",
        "imageUrl": "https://example.com/image.png",
        "downloadUrl": "https://example.com/download/image.png"
    }


@router.get("/{asset_id}/download")
async def download_asset(asset_id: str):

    return {
        "assetId": asset_id,
        "downloadUrl": f"https://example.com/assets/{asset_id}.pdf"
    }