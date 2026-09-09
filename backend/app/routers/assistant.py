from fastapi import APIRouter, Body, Depends

from app.config import settings
from app.dependencies.auth import CurrentUser, get_current_user
from app.services import deepseek_service

router = APIRouter(prefix="/assistant", tags=["Assistant"])


@router.post("/chat")
async def assistant_chat(
    payload: dict = Body(default={}),
    user: CurrentUser = Depends(get_current_user),
):
    message = payload.get("message", "")

    if not message:
        return {"reply": "Escribe un mensaje para poder ayudarte."}

    reply = await deepseek_service.generate_text(
        message,
        system_prompt="""
Eres el asistente IA de NoonDalton AI Marketing Suite.

Responde siempre en español.

Ayuda con:
- propuestas comerciales
- automatización con IA
- marketing
- outreach
- BPO
- ventas
- contenido comercial

Responde con estructura clara, párrafos cortos y bullets cuando sea útil.
NO uses markdown excesivo.
""",
        temperature=0.7,
        timeout=None,
    )

    return {"reply": reply}
