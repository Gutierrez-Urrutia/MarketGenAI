"""
Sales enablement (RF-VTA-08): borradores de casos de éxito, comparativas y respuestas a objeciones.

El borrador se arma SOLO con los documentos que el usuario cargó en su base de conocimiento
(RF-VTA-01). Sin fuentes relevantes no se llama al modelo: así no se presentan como reales
datos que el sistema no tiene. Lo que el modelo no pueda respaldar queda marcado [COMPLETAR: ...].
"""
from __future__ import annotations

import re

from app.services import deepseek_service
from app.services.rag_proposal_service import retrieve_sources

TYPES = ("case_study", "comparison", "objection")
PLACEHOLDER = "[COMPLETAR:"

_LANGUAGE_NAMES = {"es": "Spanish", "en": "English", "pt": "Portuguese"}

_TYPE_LABELS = {
    "es": {"case_study": "Caso de éxito", "comparison": "Comparativa", "objection": "Respuesta a objeción"},
    "en": {"case_study": "Case study", "comparison": "Comparison", "objection": "Objection response"},
    "pt": {"case_study": "Caso de sucesso", "comparison": "Comparativo", "objection": "Resposta a objeção"},
}

_STRUCTURES = {
    "case_study": (
        "Title (one line)\n"
        "Client and context\nChallenge\nSolution delivered\nResults\n"
        "- Results: only figures that appear in the sources; for each missing result write [COMPLETAR: describe the missing metric], with the description in the output language."
    ),
    "comparison": (
        "Title (one line)\nSummary\nComparison (a list of criteria, each with the company's position "
        "and the alternative's position)\nWhen it is the better choice\nOpen points to validate"
    ),
    "objection": (
        "Title (one line)\nThe objection (restated neutrally)\nWhat is behind it\n"
        "Suggested response (short, conversational)\nSupporting evidence from the sources\nFollow-up question for the prospect"
    ),
}

_TASKS = {
    "case_study": "a success case study about the topic",
    "comparison": "a comparison about the topic",
    "objection": "a sales response to the objection stated in the topic",
}


class NoSourcesError(Exception):
    """El usuario no tiene documentos relevantes para respaldar el borrador."""


def type_label(kind: str, language: str) -> str:
    return _TYPE_LABELS.get(_lang(language), _TYPE_LABELS["es"]).get(kind, kind)


def _lang(language: str | None) -> str:
    code = (language or "es").strip().lower()
    if code.startswith("en"):
        return "en"
    if code.startswith(("pt", "po")):
        return "pt"
    return "es"


def clean_output(text: str) -> str:
    """Quita vallas de código y marcas markdown; el borrador se edita como texto plano."""
    text = text.strip()
    text = re.sub(r"^```[a-z]*\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = text.replace("**", "")
    return text.strip()


def build_prompt(kind: str, topic: str, client_name: str, language: str, instructions: str | None, sources: list[dict]) -> str:
    lang = _lang(language)
    context = "\n\n---\n\n".join(f"[Fuente: {s['title']}]\n{s['text']}" for s in sources)
    return f"""SOURCES (documents uploaded by the company; the ONLY allowed evidence):
{context}

Write {_TASKS[kind]} for a sales team, in {_LANGUAGE_NAMES[lang]}.

Topic: {topic}
Client or prospect: {client_name or "Not provided"}
Extra instruction: {instructions or "None"}

STRICT RULES:
- Use ONLY facts, figures, names and results that appear in the SOURCES. Never invent clients, numbers, certifications or outcomes.
- If something needed is not in the SOURCES, write {PLACEHOLDER} what is missing] in its place instead of making it up. Keep the word COMPLETAR, but write the description of what is missing in the output language.
- Mention which source supports each key claim, as (Fuente: document title).
- Do not present estimates or targets as achieved results.
- Plain text only: no markdown, no #, no **, no HTML. Use short lines; start list items with "- ".
- Do not include prices unless a source states them.
- Confidentiality: the sources come from proposals written for other clients. In any text addressed to the prospect or client (the main body and the suggested response), never name or identify a client that appears in the sources; describe it generically (for example "un banco", "una cadena de retail"), unless that client is the one named in the "Client or prospect" field above. The "(Fuente: ...)" citations are internal verification notes and may keep the document title.

REQUIRED STRUCTURE (section titles on their own line, in {_LANGUAGE_NAMES[lang]}):
{_STRUCTURES[kind]}
"""


async def generate_draft(
    *,
    user_id: str,
    kind: str,
    topic: str,
    client_name: str,
    language: str,
    instructions: str | None,
) -> dict:
    """Devuelve {title, content, sources}. Lanza NoSourcesError si no hay fuentes relevantes."""
    sources = await retrieve_sources(user_id, client_name=client_name, service_type=topic)
    if not sources:
        raise NoSourcesError()

    prompt = build_prompt(kind, topic, client_name, language, instructions, sources)
    raw = await deepseek_service.generate_text(
        prompt,
        system_prompt="You are a sales enablement writer. You only state facts present in the provided sources.",
        temperature=0.3,
        timeout=None,
    )
    content = clean_output(raw)
    first_line = next((ln.strip() for ln in content.splitlines() if ln.strip()), "")
    title = first_line[:120] or f"{type_label(kind, language)}: {topic[:80]}"

    seen, unique = set(), []
    for s in sources:
        if s["docId"] not in seen:
            seen.add(s["docId"])
            unique.append({"docId": s["docId"], "title": s["title"]})
    return {"title": title, "content": content, "sources": unique}
