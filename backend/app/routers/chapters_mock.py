from fastapi import APIRouter

router = APIRouter(
    prefix="/books",
    tags=["Chapters & Content"]
)


@router.post("/{book_id}/chapters/generate")
async def generate_chapters(book_id: str):

    return {
        "jobId": "job_chapters_123",
        "status": "pending"
    }


@router.post("/{book_id}/chapters")
async def add_chapter(book_id: str, payload: dict):

    return {
        "id": "chapter_123",
        "bookId": book_id,
        "title": payload.get("title"),
        "description": payload.get("description"),
        "order": 1
    }


@router.put("/{book_id}/chapters/{chapter_id}")
async def update_chapter(book_id: str, chapter_id: str, payload: dict):

    return {
        "id": chapter_id,
        "bookId": book_id,
        "title": payload.get("title", "Updated Chapter"),
        "description": payload.get("description", ""),
    }


@router.put("/{book_id}/chapters/reorder")
async def reorder_chapters(book_id: str, payload: dict):

    return {
        "message": "Chapters reordered successfully",
        "chapters": payload.get("chapterIds", [])
    }


@router.delete("/{book_id}/chapters/{chapter_id}")
async def delete_chapter(book_id: str, chapter_id: str):

    return {
        "message": f"Chapter {chapter_id} deleted"
    }


@router.post("/{book_id}/content/generate")
async def generate_book_content(book_id: str):

    return {
        "jobId": "job_content_123",
        "status": "pending",
        "estimatedSeconds": 45
    }


@router.post("/{book_id}/chapters/{chapter_id}/content/generate")
async def generate_chapter_content(book_id: str, chapter_id: str):

    return {
        "chapterId": chapter_id,
        "content": "Generated AI chapter content..."
    }


@router.post("/{book_id}/chapters/{chapter_id}/content/refine")
async def refine_chapter_content(book_id: str, chapter_id: str, payload: dict):

    return {
        "refinedContent": "Refined AI-generated content..."
    }


@router.put("/{book_id}/chapters/{chapter_id}/content")
async def save_chapter_content(book_id: str, chapter_id: str, payload: dict):

    return {
        "chapterId": chapter_id,
        "content": payload.get("content"),
        "saved": True
    }