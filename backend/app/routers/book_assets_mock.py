from fastapi import APIRouter

router = APIRouter(
    prefix="/books",
    tags=["Book Assets"]
)


@router.get("/{book_id}/assets")
async def list_book_assets(book_id: str):

    return {
        "data": [
            {
                "id": "asset_1",
                "type": "one_pager",
                "name": "AI Marketing One Pager",
                "status": "completed",
                "downloadUrl": "https://example.com/onepager.pdf"
            }
        ]
    }


@router.post("/{book_id}/assets/one-pager")
async def generate_one_pager(book_id: str):

    return {
        "jobId": "job_onepager_123",
        "status": "pending"
    }


@router.post("/{book_id}/assets/whitepaper")
async def generate_whitepaper(book_id: str):

    return {
        "jobId": "job_whitepaper_123",
        "status": "pending"
    }


@router.post("/{book_id}/assets/social-posts")
async def generate_social_posts(book_id: str):

    return {
        "posts": [
            {
                "platform": "linkedin",
                "content": "AI is transforming modern marketing.",
                "characterCount": 42
            },
            {
                "platform": "twitter",
                "content": "AI-powered growth starts now 🚀",
                "characterCount": 35
            }
        ]
    }


@router.post("/{book_id}/assets/infographic")
async def generate_infographic(book_id: str):

    return {
        "jobId": "job_infographic_123",
        "status": "pending"
    }


@router.post("/{book_id}/export")
async def export_book(book_id: str):

    return {
        "jobId": "job_export_123",
        "status": "pending",
        "downloadUrl": "https://example.com/export/book.pdf"
    }