from fastapi import APIRouter

router = APIRouter(
    prefix="/books",
    tags=["Publishing"]
)


@router.post("/{book_id}/publish")
async def publish_book(book_id: str, payload: dict):
    platforms = payload.get("platforms", ["linkedin"])

    return {
        "results": [
            {
                "platform": platform,
                "status": "published",
                "postUrl": f"https://example.com/{platform}/post/{book_id}"
            }
            for platform in platforms
        ]
    }


@router.post("/{book_id}/translate")
async def translate_book(book_id: str, payload: dict):
    languages = payload.get("languages", ["es"])

    return {
        "jobId": "job_translate_123",
        "status": "pending",
        "languages": languages
    }