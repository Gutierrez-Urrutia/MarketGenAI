"""Chat router - stateless AI conversation endpoint backed by DeepSeek."""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.config import settings
from app.dependencies.auth import CurrentUser, get_current_user
from app.services import deepseek_service

router = APIRouter(prefix="/chat", tags=["Chat"])


SYSTEM_PROMPT = """You are an expert AI Marketing Strategist for NoonDalton AI Marketing Suite.
Your role is to help marketing managers and content creators with:
- Content strategy and planning
- Marketing performance analysis
- Publishing schedule optimisation
- Audience targeting and engagement
- B2B proposal best practices

Be concise, actionable, and data-driven in your responses.
When referencing specific content or proposals from the context provided, use them to give personalised advice.

RESPONDE SIEMPRE USANDO HTML PROFESIONAL.

REGLAS IMPORTANTES:
- NO uses Markdown
- NO uses ###
- NO uses **
- NO uses ```html
- NO uses triple backticks
- Devuelve SOLO HTML limpio

USA SOLAMENTE:
<h1>, <h2>, <h3>, <p>, <strong>, <ul>, <ol>, <li>,
<table>, <thead>, <tbody>, <tr>, <th>, <td>
"""


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    session_id: str
    message: str
    history: Optional[List[ChatMessage]] = []


class ChatResponse(BaseModel):
    response: str
    session_id: str


@router.post("", response_model=ChatResponse)
async def send_chat_message(
    body: ChatRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """
    Send a message to the AI assistant and return the reply.
    History is passed by the client (last N messages); no server-side state.
    """
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    history = [
        {"role": "assistant" if m.role == "assistant" else "user", "content": m.content}
        for m in (body.history or [])
        if m.content.strip()
    ]
    reply = await deepseek_service.generate_text(
        body.message,
        system_prompt=SYSTEM_PROMPT,
        temperature=0.7,
        timeout=settings.llm_default_timeout_seconds,
        messages=[*history, {"role": "user", "content": body.message}],
    )

    return ChatResponse(response=reply, session_id=body.session_id)
