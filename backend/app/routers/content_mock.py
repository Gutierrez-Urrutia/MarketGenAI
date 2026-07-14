from fastapi import APIRouter

router = APIRouter(
    prefix="/content",
    tags=["Content Library"]
)


@router.get("")
async def list_content():

    return {
        "items": [
            {
                "id": "content_1",
                "title": "AI Marketing Strategy",
                "type": "pdf",
                "category": "Marketing",
                "url": "/files/ai-marketing.pdf",
                "createdAt": "2026-03-01T00:00:00Z"
            },
            {
                "id": "content_2",
                "title": "Sales Outreach Templates",
                "type": "docx",
                "category": "Sales",
                "url": "/files/outreach.docx",
                "createdAt": "2026-03-02T00:00:00Z"
            }
        ],
        "total": 2
    }


@router.get("/{content_id}")
async def get_content(content_id: str):

    return {
        "id": content_id,
        "title": "AI Marketing Strategy",
        "type": "pdf",
        "category": "Marketing",
        "url": "/files/ai-marketing.pdf",
        "description": "Example content asset",
        "createdAt": "2026-03-01T00:00:00Z"
    }