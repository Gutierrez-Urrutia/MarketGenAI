from fastapi import APIRouter

router = APIRouter(
    prefix="/chat",
    tags=["Chat"]
)


@router.post("")
async def chat(payload: dict):

    message = payload.get("message", "")

    return {
        "sessionId": "session_001",
        "message": {
            "role": "assistant",
            "content": f"AI response to: {message}"
        },
        "createdAt": "2026-03-01T00:00:00Z"
    }


@router.get("/{session_id}")
async def get_chat_history(session_id: str):

    return {
        "sessionId": session_id,
        "messages": [
            {
                "role": "user",
                "content": "Create proposal",
                "createdAt": "2026-03-01T00:00:00Z"
            },
            {
                "role": "assistant",
                "content": "Proposal generated successfully",
                "createdAt": "2026-03-01T00:00:01Z"
            }
        ]
    }