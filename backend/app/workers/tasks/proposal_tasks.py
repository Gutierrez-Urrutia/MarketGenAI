"""
Celery tasks for proposal generation.

Tasks:
  task_generate_proposal — Generate proposal content using DeepSeek in background worker.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from html import escape
from pathlib import Path
from typing import Any, Dict, List, Optional

from celery import Task

from app.workers.celery_app import celery_app
from app.services import deepseek_service
from app.services.firestore_service import jobs_repo, proposals_repo
from app.services.rag_proposal_service import get_rag_context_and_sources

logger = logging.getLogger(__name__)


def _run(coro):
    """Run an async coroutine from a sync Celery task."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


def _output_dir() -> Path:
    if os.getenv("VERCEL"):
        output_dir = Path("/tmp/marketgen_generated_files")
    else:
        output_dir = Path("generated_files")
    output_dir.mkdir(exist_ok=True)
    return output_dir


def _format_proposal_line_items(line_items: list[dict] | None, total_amount: float | None) -> str:
    if not line_items:
        return (
            "No pricing items were provided. The cost table must contain only one row "
            'whose service and price both say "A definir". Do not invent services or prices.'
        )

    rows = []
    for index, item in enumerate(line_items, start=1):
        name = item.get("name") or item.get("service") or "A definir"
        qty = item.get("qty") if item.get("qty") is not None else item.get("quantity")
        unit_price = item.get("unitPrice") if item.get("unitPrice") is not None else item.get("unit_price")
        rows.append(
            f"{index}. Service: {name} | "
            f"Description: {item.get('description') or 'N/A'} | "
            f"Quantity: {qty if qty is not None else 'A definir'} | "
            f"Unit price: {unit_price if unit_price is not None else 'A definir'}"
        )

    total = total_amount if total_amount is not None else "A definir"
    return "\n".join([
        *rows,
        f"Provided total: {total}",
        "Build the HTML cost table EXACTLY from the items and amounts above. "
        "Do not invent, rename, remove, merge, or add services or prices.",
    ])


# ── Estructura de propuesta BPO (RF-VTA-01) ───────────────────────────────────
PRICING_MARKER = "[[PRICING_TABLE]]"

# Encabezados por idioma, en el orden de la propuesta. El renderizador del frontend y los
# exportadores del backend leen los <h2> tal cual, así que no dependen de nombres fijos.
SECTION_HEADINGS: dict[str, list[str]] = {
    "es": [
        "Resumen Ejecutivo",
        "Quiénes Somos",
        "Entendimiento de la Necesidad",
        "Alcance y Objetivos",
        "Modelo Operativo y Niveles de Servicio",
        "Equipo y Organización del Trabajo",
        "Plan de Implementación",
        "Precios y Condiciones Comerciales",
        "Condiciones Generales",
    ],
    "en": [
        "Executive Summary",
        "About NoonDalton",
        "Understanding of the Need",
        "Scope and Objectives",
        "Operating Model and Service Levels",
        "Team and Work Organization",
        "Implementation Plan",
        "Pricing and Commercial Terms",
        "General Terms",
    ],
    "pt": [
        "Resumo Executivo",
        "Quem Somos",
        "Entendimento da Necessidade",
        "Escopo e Objetivos",
        "Modelo Operacional e Níveis de Serviço",
        "Equipe e Organização do Trabalho",
        "Plano de Implementação",
        "Preços e Condições Comerciais",
        "Condições Gerais",
    ],
}

_PRICING_TABLE_LABELS = {
    "es": ("Servicio / Unidad", "Descripción", "Cant.", "Precio unitario", "Subtotal", "A definir"),
    "en": ("Service / Unit", "Description", "Qty", "Unit price", "Subtotal", "To be defined"),
    "pt": ("Serviço / Unidade", "Descrição", "Qtd.", "Preço unitário", "Subtotal", "A definir"),
}

_LANGUAGE_NAMES = {"es": "Spanish", "en": "English", "pt": "Portuguese"}


def _lang_code(language: str | None) -> str:
    code = (language or "es").strip().lower()
    if code.startswith("en"):
        return "en"
    if code.startswith("pt") or code.startswith("po"):
        return "pt"
    return "es"


def _to_number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def format_usd(value: float | None, fallback: str, lang: str = "en") -> str:
    """$21,950 USD en inglés; $21.950 USD en español/portugués, coherente con el texto del documento."""
    if value is None:
        return fallback
    text = f"{value:,.0f}"
    if lang in ("es", "pt"):
        text = text.replace(",", ".")
    return f"${text} USD"


def build_pricing_table_html(
    line_items: list[dict] | None,
    total_amount: float | None,
    language: str = "es",
) -> str:
    """Tabla de precios determinista: el LLM nunca escribe cifras, solo se muestran las ingresadas."""
    lang = _lang_code(language)
    h_service, h_desc, h_qty, h_unit, h_sub, undefined = _PRICING_TABLE_LABELS[lang]
    rows = []
    for item in line_items or []:
        name = item.get("name") or item.get("service") or undefined
        qty = _to_number(item.get("qty") if item.get("qty") is not None else item.get("quantity"))
        unit = _to_number(item.get("unitPrice") if item.get("unitPrice") is not None else item.get("unit_price"))
        subtotal = qty * unit if qty is not None and unit is not None else None
        qty_text = undefined if qty is None else f"{qty:g}"
        rows.append(
            f"<tr><td>{escape(str(name))}</td><td>{escape(str(item.get('description') or '—'))}</td>"
            f"<td>{escape(qty_text)}</td><td>{format_usd(unit, undefined, lang)}</td><td>{format_usd(subtotal, undefined, lang)}</td></tr>"
        )
    if not rows:
        rows.append(f"<tr><td>{undefined}</td><td>—</td><td>—</td><td>{undefined}</td><td>{undefined}</td></tr>")
    return (
        '<table class="pricing-table"><thead><tr>'
        f"<th>{h_service}</th><th>{h_desc}</th><th>{h_qty}</th><th>{h_unit}</th><th>{h_sub}</th>"
        f"</tr></thead><tbody>{''.join(rows)}</tbody></table>"
    )


def _strip_code_fences(content: str) -> str:
    content = content.strip()
    content = re.sub(r"^```(?:html)?\s*", "", content, flags=re.IGNORECASE)
    return re.sub(r"\s*```$", "", content).strip()


def inject_pricing_table(content: str, table_html: str) -> str:
    """Sustituye el marcador por la tabla real; si el LLM lo omitió, la inserta antes de la última sección."""
    marker = re.compile(
        r"<p>\s*" + re.escape(PRICING_MARKER) + r"\s*</p>|" + re.escape(PRICING_MARKER), re.IGNORECASE
    )
    if marker.search(content):
        return marker.sub(lambda _m: table_html, content, count=1)
    h2s = list(re.finditer(r"<h2[ >]", content, flags=re.IGNORECASE))
    if len(h2s) >= 2:
        pos = h2s[-1].start()
        return content[:pos] + table_html + "\n" + content[pos:]
    return content + "\n" + table_html


def _length_instructions(headings: list[str]) -> dict[str, str]:
    h = headings
    anti_filler = (
        "Anti-filler requirement:\n"
        "Never increase length through repetition, generic filler, empty phrases, vague claims, or padded "
        "wording. Write like a senior commercial consultant at a BPO company preparing a serious "
        "client-facing proposal. Be specific to this client and service."
    )
    return {
        "brief": (
            "Generate a concise professional proposal of approximately 500-700 words, about 1-2 pages.\n"
            f'Keep all nine sections but write each one tightly: "{h[0]}", "{h[1]}" and "{h[2]}" in 1 paragraph each, '
            "scope/objectives and service levels as short bullet lists, a compact team list, a 3-4 step plan, "
            "and 4-5 general terms.\n" + anti_filler
        ),
        "standard": (
            "Generate a complete professional proposal of approximately 1000-1400 words, about 3-4 pages.\n"
            f'Develop every section with substance: 2 short paragraphs for "{h[0]}" and "{h[2]}", 1 paragraph for "{h[1]}", 4-6 bullets '
            "for scope and objectives, 4-6 measurable service levels, a team list with roles and headcount, an "
            "implementation plan with phases and estimated weeks, and 5-7 general terms.\n" + anti_filler
        ),
        "extended": (
            "Generate an extensive professional proposal of approximately 1500-2000 words, designed to produce "
            "5-6 pages maximum when rendered. Never exceed 6 rendered pages.\n"
            f'Develop every section in depth while staying within the 5-6 pages maximum: context and business '
            f'impact in "{h[2]}", detailed scope with in-scope and out-of-scope items, service levels with '
            "measurement method and reporting cadence, team structure and governance (committees, escalation), "
            "phased implementation with weeks, risks and mitigations, and 6-8 general terms.\n"
            "If depth and page count conflict, prioritize the 6-page maximum.\n" + anti_filler
        ),
    }


async def _generate_proposal_content(
    title: str,
    client_name: str,
    description: str,
    *,
    detailed_description: str | None = None,
    team_sizing: str | None = None,
    line_items: list[dict] | None = None,
    total_amount: float | None = None,
    length: str = "standard",
    language: str = "es",
    custom_prompt: str | None = None,
    user_id: str | None = None,
) -> dict:
    """Call the LLM with the real proposal context and persist its response."""
    lang = _lang_code(language)
    headings = SECTION_HEADINGS[lang]
    length_instructions = _length_instructions(headings)
    pricing_context = _format_proposal_line_items(line_items, total_amount)
    rag_context, sources = await get_rag_context_and_sources(
        user_id,
        client_name=client_name,
        service_type=f"{title} {description}",
        extra_query=detailed_description or "",
    )
    structure = "\n".join(
        [
            "<h1>Proposal title</h1>",
            "<p>One-line subtitle</p>",
            f"<h2>{headings[0]}</h2>\n<p>Client situation, proposed service and expected value, in short paragraphs.</p>",
            f"<h2>{headings[1]}</h2>\n<p>Who the company is and its BPO capabilities, using ONLY facts from the historical company context.</p>",
            f"<h2>{headings[2]}</h2>\n<p>Client context, pain points and impact, based ONLY on the data provided.</p>",
            f"<h2>{headings[3]}</h2>\n<ul><li>In-scope activity or objective</li></ul>",
            f"<h2>{headings[4]}</h2>\n<p>How the service operates (channels, schedule, tools, quality control).</p>\n"
            "<ul><li>Service level: indicator, proposed target (to be validated) and how it is measured</li></ul>",
            f"<h2>{headings[5]}</h2>\n<ul><li>Role: headcount and responsibility</li></ul>",
            f"<h2>{headings[6]}</h2>\n<ol><li>Phase: activities and estimated weeks</li></ol>",
            f"<h2>{headings[7]}</h2>\n<p>{PRICING_MARKER}</p>\n"
            "<ul><li>Commercial term (billing, payment, validity, adjustments, currency, taxes)</li></ul>",
            f"<h2>{headings[8]}</h2>\n"
            "<ul><li>General term (confidentiality, assumptions)</li>"
            "<li>Exclusions: what the service does not include</li>"
            "<li>Termination: proposed notice period, subject to agreement</li></ul>",
        ]
    )
    prompt = f"""
{rag_context}

Generate a PREMIUM BPO commercial proposal in the following language: {_LANGUAGE_NAMES[lang]}.

Title: {title}
Client: {client_name}
Description: {description}
Detailed client process: {detailed_description or "Not provided"}
Team sizing and roles: {team_sizing or "Not provided"}

PRIORITY STYLE AND FOCUS INSTRUCTION:
{custom_prompt or "No additional instruction provided."}

LENGTH REQUIREMENT:
{length_instructions.get(length, length_instructions["standard"])}

CONTENT QUALITY INSTRUCTIONS:
- The service is business process outsourcing (BPO): describe people, process, service levels and governance, not generic "AI solutions".
- Use the historical company context above, when present, for service descriptions, structure, tone and typical service levels. Never copy client names, prices or figures from it.
- Use ONLY facts about this client that appear in the data above. When something is unknown, state it as an assumption to validate (for example "Assumption: monthly volume to be confirmed") instead of inventing it.
- Service levels must be measurable (indicator, target, measurement method). Label every target as a proposed target to be validated against the client's baseline during the diagnostic phase; never present it as a guarantee.
- This is a client-facing document: NEVER mention internal CRM or sales-pipeline data such as the opportunity stage, "fit score", qualification score or lead status.
- "About" section: include only company facts present in the historical company context (years, locations, capabilities). If there are none, write one short neutral paragraph about the service capability without figures, names or certifications.
- Commercial terms: state the currency (USD), the billing period, and that prices exclude applicable taxes unless the data says otherwise (mark it as an assumption). Contract duration, notice periods and payment terms taken from the historical context must be labeled as standard terms subject to agreement.
- General conditions must always include explicit exclusions (what is NOT included) and a termination clause with a proposed notice period. Label the notice period and any legal term as "subject to agreement and legal review"; never present them as fixed or final.
- Team: use the provided sizing and roles when given; otherwise propose a reasonable structure and label it as a proposal.
- Team and pricing must be consistent: every role beyond the provided sizing must be explicitly described as included in the unit price, or as optional and priced separately. Never list a role as part of the service without saying how it is covered commercially.
- Do not attribute statements to the client ("the client states/requires...") unless they appear in the data above. Market observations must be phrased as general context, and definitions that the data does not give (for example delinquency buckets) must be labeled as assumptions to validate.
- Implementation plan: 3-5 sequenced phases with estimated weeks.
- Never write prices or amounts yourself. The system inserts the pricing table.
- Forbidden: paragraphs longer than 5 consecutive sentences, empty phrases such as "comprehensive solution", "holistic approach", or "cutting-edge" without substance, and repeating information already stated in another section.
- Format list items that name something as "Clear item name: explanation".

PRICING DATA AND NON-NEGOTIABLE RULES:
{pricing_context}
Place the exact text {PRICING_MARKER} alone in its own paragraph inside the pricing section. Do not write a table yourself.

IMPORTANT RULES:
- Respond ONLY with a clean semantic HTML fragment.
- Do not include <html>, <body>, <article>, or any outer <div> container.
- Do not use inline styles, style attributes, CSS classes, markdown, **, ###, ---, or backticks.
- Use only these HTML tags: <h1>, <h2>, <p>, <ul>, <ol>, <li>, <strong>.
- Use exactly the section headings below, in this order, written in {_LANGUAGE_NAMES[lang]}; write ALL body text in {_LANGUAGE_NAMES[lang]}.
- Follow the PRIORITY STYLE AND FOCUS INSTRUCTION above when provided.

REQUIRED STRUCTURE:
{structure}
"""

    content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You are a senior commercial consultant writing BPO service proposals.",
        temperature=0.5,
        timeout=None,
    )
    content = inject_pricing_table(
        _strip_code_fences(content),
        build_pricing_table_html(line_items, total_amount, lang),
    )

    output_dir = _output_dir()
    filename = f"proposal-{uuid.uuid4()}.md"
    file_path = output_dir / filename
    file_path.write_text(content, encoding="utf-8")

    return {
        "content": content,
        "downloadUrl": str(file_path),
        "filePath": str(file_path),
        "sources": sources,
    }


async def generate_proposal_now(
    job_id: str,
    proposal_id: str,
    title: str,
    client_name: str,
    description: str,
    options: Dict[str, Any],
) -> Dict[str, Any]:
    """Generate proposal content using DeepSeek and update Firestore.
    Shared by the Celery task and the sync fallback used when Celery/Redis is unavailable.
    """
    await jobs_repo.update_progress(job_id, 20, "processing")
    await proposals_repo.update(proposal_id, {"status": "generating"})

    detailed_description = options.get("detailedDescription") or options.get("detailed_description")
    team_sizing = options.get("teamSizing") or options.get("team_sizing")
    raw_line_items = (
        options.get("lineItems")
        or options.get("line_items")
        or options.get("pricingRows")
        or options.get("pricing_rows")
    )
    if raw_line_items:
        line_items = [
            item.model_dump() if hasattr(item, "model_dump") else item
            for item in raw_line_items
        ]
    else:
        line_items = None

    total_amount = options.get("totalAmount")
    if total_amount is None:
        total_amount = options.get("total_amount")

    length = options.get("length", "standard")
    language = options.get("language", "es")
    custom_prompt = options.get("customPrompt") or options.get("custom_prompt")

    generated = await _generate_proposal_content(
        title,
        client_name,
        description,
        detailed_description=detailed_description,
        team_sizing=team_sizing,
        line_items=line_items,
        total_amount=total_amount,
        length=length,
        language=language,
        custom_prompt=custom_prompt,
        user_id=options.get("userId"),
    )

    await jobs_repo.update_progress(job_id, 80, "processing")

    updated = await proposals_repo.update(proposal_id, {
        "content": generated["content"],
        "downloadUrl": generated["downloadUrl"],
        "filePath": generated["filePath"],
        "sources": generated.get("sources", []),
        "status": "generated",
        "language": language,
        "customPrompt": custom_prompt,
    })

    await jobs_repo.complete_job(job_id, {
        "proposalId": proposal_id,
        "status": "generated",
    })
    logger.info("proposal done: job=%s proposal=%s", job_id, proposal_id)
    return updated


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10, queue="llm")
def task_generate_proposal(
    self: Task,
    job_id: str,
    proposal_id: str,
    title: str,
    client_name: str,
    description: str,
    options: Dict[str, Any],
):
    """Generate proposal content via background Celery task."""
    try:
        _run(generate_proposal_now(job_id, proposal_id, title, client_name, description, options))
    except Exception as exc:
        logger.exception("task_generate_proposal failed: job=%s proposal=%s", job_id, proposal_id)
        _run(proposals_repo.update(proposal_id, {"status": "error"}))
        _run(jobs_repo.fail_job(job_id, str(exc)))
        raise self.retry(exc=exc)
