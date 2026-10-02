"""
Celery tasks for proposal generation.

Tasks:
  task_generate_proposal — Generate proposal content using DeepSeek in background worker.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from celery import Task

from app.workers.celery_app import celery_app
from app.services import deepseek_service
from app.services.firestore_service import jobs_repo, proposals_repo
from app.services.rag_netprovider import get_rag_context

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
) -> dict:
    """Call the LLM with the real proposal context and persist its response."""
    length_instructions = {
        "brief": """
Generate a concise professional proposal of approximately 400-600 words, designed to produce about 1 page of substantive content.

Depth requirement:
- Keep every required section present and complete, but synthesize each section tightly.
- Executive Summary must be concise and client-specific, explaining the opportunity and proposed value in a few strong paragraphs.
- Problems Identified must summarize the most important client problems without over-expanding.
- Proposed AI Solution must clearly explain the recommended approach and how it addresses the identified problems.
- Implementation Costs must use ONLY the provided pricing data. Do not invent, rename, remove, merge, or add services or prices.
- Expected ROI must briefly describe practical business impact areas and measurable outcomes where appropriate. Do not invent unsupported financial figures.
- Next Steps must be short, practical, and action-oriented.

Anti-filler requirement:
The proposal must gain clarity through specificity, client-relevant analysis, concrete examples, and professional detail. Never increase length through repetition, generic filler, empty phrases, vague claims, or padded wording. Write like a senior commercial consultant preparing a serious client-facing proposal.

Respect the 400-600 word target as closely as possible while preserving quality, the required HTML structure, the exact section headings, the requested language, the custom prompt, and all pricing rules.
""".strip(),
        "standard": """
Generate a complete standard professional proposal of approximately 900-1300 words, designed to produce about 3 pages of substantive content.

Depth requirement:
- Develop every required section with 1-2 substantial paragraphs where appropriate.
- Executive Summary must explain the client's business context, the opportunity, and the strategic value of the proposed engagement.
- Problems Identified must include clear points with operational, process, quality, financial, or growth implications based on the client description, detailed process, industry, and team sizing provided.
- Proposed AI Solution must explain the recommended approach, operating model, workflow, technologies, and how the solution addresses each identified problem.
- Implementation Costs must use ONLY the provided pricing data. Do not invent, rename, remove, merge, or add services or prices.
- Expected ROI must include concrete business impact areas, operational metrics, efficiency gains, quality improvements, risk reduction, and measurable outcomes where appropriate. Do not invent unsupported financial figures.
- Next Steps must be practical, sequenced, and clear enough for a client to act on.

Anti-filler requirement:
The proposal must gain length through real depth, specificity, client-relevant analysis, concrete examples, and professional detail. Never increase length through repetition, generic filler, empty phrases, vague claims, or padded wording. Write like a senior commercial consultant preparing a serious client-facing proposal.

Respect the 900-1300 word target as closely as possible while preserving quality, the required HTML structure, the exact section headings, the requested language, the custom prompt, and all pricing rules.
""".strip(),
        "extended": """
Generate an extensive professional proposal of approximately 1100-1400 words, designed to produce 5-6 pages maximum when rendered. Never exceed 6 rendered pages.

Depth requirement:
- Develop every required section in depth, but stay concise enough for a 5-6 page final document.
- Executive Summary must be broad and consultative, explaining the client's business context, why the opportunity matters, and the strategic value of the proposed engagement.
- Problems Identified must include several detailed points with operational, financial, process, quality, or growth implications based on the client description, detailed process, industry, and team sizing provided.
- Proposed AI Solution must explain the recommended approach, operating model, workflow, technologies, implementation logic, and how the solution addresses each identified problem.
- Implementation Costs must use ONLY the provided pricing data. Do not invent, rename, remove, merge, or add services or prices.
- Expected ROI must include concrete business impact areas, operational metrics, efficiency gains, quality improvements, risk reduction, and measurable outcomes where appropriate. Do not invent unsupported financial figures.
- Include risks, constraints, assumptions, and mitigations inside the most relevant sections when applicable, especially in Proposed AI Solution or Expected ROI.
- Next Steps must be detailed and practical, with clear sequencing, stakeholder actions, validation activities, and decision points, without expanding beyond what is needed for the 5-6 page maximum.

Anti-filler requirement:
The proposal must gain length through real depth, specificity, client-relevant analysis, concrete examples, and professional detail. Never increase length through repetition, generic filler, empty phrases, vague claims, or padded wording. Write like a senior commercial consultant preparing a serious client-facing proposal.

Respect the 1100-1400 word target and the hard maximum of 6 rendered pages. If there is any conflict between depth and page count, prioritize the 6-page maximum while preserving quality, the required HTML structure, the exact section headings, the requested language, the custom prompt, and all pricing rules.
""".strip(),
    }
    pricing_context = _format_proposal_line_items(line_items, total_amount)
    rag_context = get_rag_context(
        client_name=client_name,
        service_type=description,
    )
    prompt = f"""
{rag_context}

Generate a PREMIUM commercial proposal in the following language: {language}.

Title: {title}
Client: {client_name}
Description: {description}
Detailed client process: {detailed_description or "Not provided"}
Team sizing and roles: {team_sizing or "Not provided"}

PRIORITY STYLE AND FOCUS INSTRUCTION:
{custom_prompt or "No additional instruction provided."}

LENGTH REQUIREMENT:
{length_instructions[length]}

CONTENT QUALITY INSTRUCTIONS:
- Each section must be developed with real client-specific analysis, not generic filler.
- Problems Identified: exactly 4-5 problems, each with a clear problem name and 2-3 sentences explaining concrete impact on this specific client's business.
- Proposed AI Solution: describe the real operating workflow step by step, with concrete technical logic. Do not say "advanced AI" generically; explain what type of model or automation is used and what it does.
- Technologies Used: exactly 4-6 technologies, each with a real technical name and an explanation of why it applies to this specific case.
- Expected ROI: include at least 3 projected metrics with justified percentages or numeric ranges. Do not invent unsupported financial figures or costs.
- Next Steps: include 4-5 sequenced steps with estimated weeks.
- Forbidden: paragraphs longer than 5 consecutive sentences, empty phrases such as "comprehensive solution", "holistic approach", or "cutting-edge" without substance, and repeating information already stated in another section.
- Format Problems Identified and Technologies Used list items as "Clear item name: 2-3 sentence explanation" so the renderer can emphasize the item name without making the whole item bold.

PRICING DATA AND NON-NEGOTIABLE RULES:
{pricing_context}

IMPORTANT RULES:
- Respond ONLY with a clean semantic HTML fragment.
- Do not include <html>, <body>, <article>, or any outer <div> container.
- Do not use inline styles, style attributes, CSS classes, markdown, **, ###, ---, or backticks.
- Use only these HTML tags: <h1>, <h2>, <p>, <ul>, <li>, <table>, <thead>, <tbody>, <tr>, <th>, and <td>.
- Use short paragraphs, semantic lists, and professional HTML tables. The frontend, PDF, and DOCX renderers control all visual design.
- Keep these exact English section headings as structural markers; write ALL
  body text, descriptions, labels, and table content in {language}.
- Follow the PRIORITY STYLE AND FOCUS INSTRUCTION above when provided.
- Use the detailed client process and team sizing when provided.
- The pricing table must follow the PRICING DATA AND NON-NEGOTIABLE RULES exactly.

REQUIRED STRUCTURE:
<h1>Proposal title</h1>
<p>Professional subtitle</p>
<h2>Executive Summary</h2>
<p>Separate text into short paragraphs.</p>
<h2>Problems Identified</h2>
<ul><li>Relevant client problem</li></ul>
<h2>Proposed AI Solution</h2>
<p>Professional explanation based on the provided client context.</p>
<h2>Technologies Used</h2>
<ul><li>Relevant technology or capability</li></ul>
<h2>Implementation Costs</h2>
<table><thead><tr><th>Service / Unit</th><th>Description</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th></tr></thead><tbody><tr><td>Use provided pricing data only</td><td>Use provided pricing data only</td><td>Use provided pricing data only</td><td>Use provided pricing data only</td><td>Use provided pricing data only</td></tr></tbody></table>
<h2>Expected ROI</h2>
<p>Professional financial explanation.</p>
<h2>Next Steps</h2>
<p>Professional closing and recommended actions.</p>
"""

    content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You are an expert marketing proposal writer.",
        temperature=0.7,
        timeout=None,
    )

    output_dir = _output_dir()
    filename = f"proposal-{uuid.uuid4()}.md"
    file_path = output_dir / filename
    file_path.write_text(content, encoding="utf-8")

    return {
        "content": content,
        "downloadUrl": str(file_path),
        "filePath": str(file_path),
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
    )

    await jobs_repo.update_progress(job_id, 80, "processing")

    updated = await proposals_repo.update(proposal_id, {
        "content": generated["content"],
        "downloadUrl": generated["downloadUrl"],
        "filePath": generated["filePath"],
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
