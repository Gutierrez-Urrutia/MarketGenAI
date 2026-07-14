"""AI generation endpoints for Content Library content types."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.config import settings
from app.dependencies.auth import CurrentUser, get_current_user
from app.rendering.content_items import build_content_item_pdf
from app.services import deepseek_service
from app.services.firestore_service import FirestoreRepo

router = APIRouter(prefix="/generate")


class ContentItemsRepo(FirestoreRepo):
    collection = "contentItems"


content_items_repo = ContentItemsRepo()

CONTENT_ITEM_PDF_TYPES = {"case_study", "whitepaper", "template", "one_pager"}


class CaseStudyInput(BaseModel):
    client_name: str
    industry: str
    region: str
    duration_months: int
    challenge: str
    solution: str
    metric_1_label: str
    metric_1_value: str
    metric_2_label: str
    metric_2_value: str
    metric_3_label: str
    metric_3_value: str
    testimonial_quote: str
    testimonial_name: str
    testimonial_role: str
    language: str = "en"


class WhitepaperInput(BaseModel):
    title: str
    subtitle: str
    topic: str
    target_audience: str
    key_sections: list[str] = Field(..., min_length=3, max_length=5)
    abstract: str
    language: str = "en"


class TemplateInput(BaseModel):
    template_name: str
    channel: str
    category: str
    tone: str
    use_case: str
    merge_variables: list[str]
    language: str = "en"


class SocialPostInput(BaseModel):
    platform: str
    topic: str
    tone: str
    target_audience: str
    cta_text: str
    key_points: list[str] = Field(..., min_length=1)
    language: str = "en"


class OnePagerInput(BaseModel):
    product_name: str
    tagline: str
    target_audience: str
    features: list[str] = Field(..., min_length=3, max_length=4)
    metric_1_label: str
    metric_1_value: str
    metric_2_label: str
    metric_2_value: str
    metric_3_label: str
    metric_3_value: str
    cta_text: str
    cta_url: str
    language: str = "en"


async def _persist_content_item(
    *,
    user_id: str,
    content_type: Literal["case_study", "whitepaper", "template", "one_pager", "social_post"],
    title: str,
    content: str,
    language: str,
    input_data: dict,
) -> dict:
    now = datetime.now(timezone.utc)
    return await content_items_repo.create({
        "userId": user_id,
        "type": content_type,
        "title": title,
        "content": content,
        "language": language,
        "input_data": input_data,
        "created_at": now,
        "updated_at": now,
    })


@router.get("/content-items/{item_id}/download")
async def download_content_item(
    item_id: str,
    format: str = "pdf",
    current_user: CurrentUser = Depends(get_current_user),
):
    item = await content_items_repo.get(item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Content item not found.")
    if item.get("userId") != current_user.sub:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")
    if format != "pdf":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Only PDF export is supported.")

    item_type = item.get("type")
    if item_type not in CONTENT_ITEM_PDF_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Backend PDF export is not available for content type '{item_type}'.",
        )

    pdf_bytes = build_content_item_pdf(
        item_type,
        item.get("content", ""),
        {
            "title": item.get("title", ""),
            "language": item.get("language", "en"),
            "input_data": item.get("input_data", {}),
        },
    )
    filename = (item.get("title") or item_type or "content").replace("/", "_").replace("\\", "_")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}.pdf"'},
    )


@router.delete("/content-items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_content_item(item_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Delete a Case Study / Whitepaper / Template / One-Pager generated via this router."""
    item = await content_items_repo.get(item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Content item not found.")
    if item.get("userId") != current_user.sub:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")
    await content_items_repo.delete(item_id)


@router.post("/case-study", status_code=status.HTTP_201_CREATED)
async def generate_case_study(body: CaseStudyInput, current_user: CurrentUser = Depends(get_current_user)):
    data = body.model_dump(mode="json")
    prompt = f"""
Generate a professional Case Study document in {body.language} for NoonDalton AI Marketing Suite.

Client: {body.client_name} | Industry: {body.industry} | Region: {body.region} | Duration: {body.duration_months} months
Challenge provided: {body.challenge}
Solution provided: {body.solution}
Metrics provided by user:
- {body.metric_1_label}: {body.metric_1_value}
- {body.metric_2_label}: {body.metric_2_value}
- {body.metric_3_label}: {body.metric_3_value}
Testimonial: "{body.testimonial_quote}" - {body.testimonial_name}, {body.testimonial_role}

METRIC VALIDATION RULES - check that provided metrics are realistic for this industry:
- Retail/D2C benchmarks: CAC reduction 20-45%, ROAS improvement 2x-5x, lead increase 80-200%
- B2B SaaS benchmarks: pipeline growth 30-60%, sales cycle reduction 15-30%, conversion lift 20-50%
- Financial services: processing time reduction 40-70%, error rate reduction 60-90%
- If a provided metric is outside realistic industry range, adjust it to the nearest realistic boundary and note the adjustment.

OUTPUT FORMAT - return clean semantic HTML only, no markdown, no div containers, no style attributes:
<h1>[Compelling headline about the result, not just the client name]</h1>
<div class="cs-meta"><span>{body.industry}</span><span>{body.region}</span><span>{body.duration_months} months</span></div>
<div class="cs-metrics">
  <div class="cs-metric"><span class="cs-metric-value">{body.metric_1_value}</span><span class="cs-metric-label">{body.metric_1_label}</span></div>
  <div class="cs-metric"><span class="cs-metric-value">{body.metric_2_value}</span><span class="cs-metric-label">{body.metric_2_label}</span></div>
  <div class="cs-metric"><span class="cs-metric-value">{body.metric_3_value}</span><span class="cs-metric-label">{body.metric_3_label}</span></div>
</div>
<h2>The Challenge</h2>
<p>[Expand challenge with industry context, 3-4 sentences, specific to {body.industry}]</p>
<h2>The Solution</h2>
<ul><li>[Solution point 1]</li><li>[Solution point 2]</li><li>[Solution point 3]</li></ul>
<h2>Results</h2>
<p>[Narrative connecting the metrics to business outcomes, 2-3 sentences]</p>
<blockquote class="cs-testimonial">"{body.testimonial_quote}" - {body.testimonial_name}, {body.testimonial_role}, {body.client_name}</blockquote>

RULES:
- Language: {body.language}. Every word must be in this language.
- Do NOT invent metrics beyond what user provided
- Do NOT add fictional client details
- Headline must lead with the result, not the client name
- Maximum 500 words total
"""
    content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You generate polished marketing content as semantic HTML.",
        timeout=settings.llm_long_timeout_seconds,
    )
    return await _persist_content_item(
        user_id=current_user.sub,
        content_type="case_study",
        title=body.client_name,
        content=content,
        language=body.language,
        input_data=data,
    )


@router.post("/whitepaper", status_code=status.HTTP_201_CREATED)
async def generate_whitepaper(body: WhitepaperInput, current_user: CurrentUser = Depends(get_current_user)):
    data = body.model_dump(mode="json")
    prompt = f"""
Generate a professional Whitepaper document in {body.language} for NoonDalton AI Marketing Suite.

Title: {body.title}
Subtitle: {body.subtitle}
Topic: {body.topic}
Target audience: {body.target_audience}
Abstract provided: {body.abstract}
Key sections to cover: {', '.join(body.key_sections)}

OUTPUT FORMAT - clean semantic HTML only:
<h1>{body.title}</h1>
<p class="wp-subtitle">{body.subtitle}</p>
<div class="wp-meta"><span>NoonDalton Research</span><span>[current year]</span><span>{len(body.key_sections) * 2} pages</span></div>
<h2>Abstract</h2>
<p>[Expand abstract to 3-4 sentences with a compelling statistic relevant to {body.topic}]</p>
<h2>Table of Contents</h2>
<ol>[one <li> per section from key_sections]</ol>
[For each section in key_sections:]
<h2>[Section title]</h2>
<p>[3-4 sentences of substantive content about this section, relevant to {body.target_audience} in the context of {body.topic}]</p>
<h2>Conclusions</h2>
<p>[2-3 sentences summarizing key takeaways and recommending next steps with NoonDalton]</p>

RULES:
- Language: {body.language}. Every word must be in this language.
- Each section must have real insight, not filler
- Include at least one data point or statistic per major section (use realistic industry benchmarks, not invented numbers)
- Maximum 800 words total
"""
    content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You generate polished marketing content as semantic HTML.",
        timeout=settings.llm_long_timeout_seconds,
    )
    return await _persist_content_item(
        user_id=current_user.sub,
        content_type="whitepaper",
        title=body.title,
        content=content,
        language=body.language,
        input_data=data,
    )


@router.post("/template", status_code=status.HTTP_201_CREATED)
async def generate_template(body: TemplateInput, current_user: CurrentUser = Depends(get_current_user)):
    data = body.model_dump(mode="json")
    merge_variables = ", ".join([f"{{{{{variable}}}}}" for variable in body.merge_variables])
    prompt = f"""
Generate a professional communication template in {body.language} for NoonDalton AI Marketing Suite.

Template name: {body.template_name}
Channel: {body.channel}
Category: {body.category}
Tone: {body.tone}
Use case: {body.use_case}
Merge variables available: {merge_variables}

OUTPUT FORMAT - clean semantic HTML only:
<h1>{body.template_name}</h1>
<div class="tpl-meta">
  <span class="tpl-channel">{body.channel}</span>
  <span class="tpl-category">{body.category}</span>
  <span class="tpl-tone">{body.tone}</span>
</div>
<div class="tpl-subject">
  <strong>Subject line:</strong>
  <p>[Compelling subject line using merge variables where appropriate, optimized for {body.channel} open rates]</p>
</div>
<div class="tpl-body">
  <p>[Opening line - {body.tone} tone, references {{{{first_name}}}} if available]</p>
  <p>[Core message - addresses {body.use_case} specifically, 2-3 sentences]</p>
  <p>[Value proposition - what NoonDalton offers that solves their problem]</p>
  <p>[CTA - clear single action, appropriate for {body.category} stage]</p>
  <p>[Sign-off appropriate for {body.tone} tone]</p>
</div>
<div class="tpl-variables">
  <h2>Merge Variables</h2>
  <ul>[one <li> per variable with description of what it should contain]</ul>
</div>

RULES:
- Language: {body.language}. Every word must be in this language.
- Subject line must be under 50 characters
- Body must be under 200 words
- Every merge variable provided must appear at least once in subject or body
- Tone must be consistent throughout: {body.tone}
- Category context: follow_up=warm re-engagement, cold_outreach=first contact, post_demo=next step push, nurture=education+value
"""
    content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You generate polished marketing content as semantic HTML.",
        timeout=settings.llm_long_timeout_seconds,
    )
    return await _persist_content_item(
        user_id=current_user.sub,
        content_type="template",
        title=body.template_name,
        content=content,
        language=body.language,
        input_data=data,
    )


@router.post("/social-post", status_code=status.HTTP_201_CREATED)
async def generate_social_post(body: SocialPostInput, current_user: CurrentUser = Depends(get_current_user)):
    data = body.model_dump(mode="json")
    prompt = f"""
Generate a social media post in {body.language} for NoonDalton AI Marketing Suite.

Platform: {body.platform}
Topic: {body.topic}
Tone: {body.tone}
Target audience: {body.target_audience}
Key points to include: {', '.join(body.key_points)}
CTA: {body.cta_text}

OUTPUT FORMAT - clean semantic HTML only, no markdown, no div containers, no style attributes:
<p class="sp-hook">[Attention-grabbing opening line, 1 sentence]</p>
<p class="sp-body">[Body copy expanding on the key points, length appropriate for {body.platform}]</p>
<p class="sp-cta">{body.cta_text}</p>
<p class="sp-hashtags">[3-5 relevant hashtags separated by spaces]</p>

RULES:
- Language: {body.language}. Every word must be in this language.
- Platform length rules: Twitter/X max 280 characters total; LinkedIn 150-300 words; Instagram/Facebook 80-150 words.
- Tone must be consistent throughout: {body.tone}
- Every key point provided must be reflected in the body
- Do NOT invent statistics or claims beyond what the key points imply
"""
    content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You generate polished marketing content as semantic HTML.",
        timeout=settings.llm_default_timeout_seconds,
    )
    return await _persist_content_item(
        user_id=current_user.sub,
        content_type="social_post",
        title=body.topic,
        content=content,
        language=body.language,
        input_data=data,
    )


@router.post("/one-pager", status_code=status.HTTP_201_CREATED)
async def generate_one_pager(body: OnePagerInput, current_user: CurrentUser = Depends(get_current_user)):
    data = body.model_dump(mode="json")
    prompt = f"""
Generate a professional One-Pager document in {body.language} for NoonDalton AI Marketing Suite.

Product/Service: {body.product_name}
Tagline: {body.tagline}
Target audience: {body.target_audience}
Key features: {', '.join(body.features)}
Metrics provided:
- {body.metric_1_label}: {body.metric_1_value}
- {body.metric_2_label}: {body.metric_2_value}
- {body.metric_3_label}: {body.metric_3_value}
CTA: {body.cta_text} -> {body.cta_url}

METRIC VALIDATION - same industry benchmark rules as Case Study apply.

OUTPUT FORMAT - clean semantic HTML only:
<h1>{body.product_name}</h1>
<p class="op-tagline">{body.tagline}</p>
<p class="op-intro">[2-3 sentence description of what {body.product_name} does and why {body.target_audience} needs it]</p>
<h2>What's included</h2>
<ol>[one <li> per feature with a one-line benefit description]</ol>
<h2>Typical results</h2>
<div class="op-metrics">
  <div class="op-metric"><span class="op-metric-value">{body.metric_1_value}</span><span class="op-metric-label">{body.metric_1_label}</span></div>
  <div class="op-metric"><span class="op-metric-value">{body.metric_2_value}</span><span class="op-metric-label">{body.metric_2_label}</span></div>
  <div class="op-metric"><span class="op-metric-value">{body.metric_3_value}</span><span class="op-metric-label">{body.metric_3_label}</span></div>
</div>
<h2>How it works</h2>
<ol>
  <li><strong>Step 1:</strong> [onboarding/setup]</li>
  <li><strong>Step 2:</strong> [AI generation/automation]</li>
  <li><strong>Step 3:</strong> [measure/optimize]</li>
</ol>
<div class="op-cta">
  <p>{body.cta_text}</p>
  <a href="{body.cta_url}">{body.cta_url}</a>
</div>

RULES:
- Language: {body.language}. Every word must be in this language.
- Maximum 300 words total
- Every feature must have a concrete benefit, not just a label
- Steps must be action-oriented and specific to {body.product_name}
"""
    content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You generate polished marketing content as semantic HTML.",
        timeout=settings.llm_long_timeout_seconds,
    )
    return await _persist_content_item(
        user_id=current_user.sub,
        content_type="one_pager",
        title=body.product_name,
        content=content,
        language=body.language,
        input_data=data,
    )
