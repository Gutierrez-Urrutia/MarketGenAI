"""Outreach router - authenticated AI response review queue."""
import json
import re
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings
from app.core.rate_limit import limiter
from app.dependencies.auth import CurrentUser, get_current_user
from app.services import deepseek_service
from app.services.firestore_service import FirestoreRepo, proposals_repo

router = APIRouter()


class OutreachRepo(FirestoreRepo):
    collection = "outreach"


outreach_repo = OutreachRepo()

RESPONSE_TYPES = {"email", "proposal", "whitepaper", "followup"}
QUEUE_STATUSES = {"pending", "sent", "rejected"}
MAX_CLASSIFICATION_CONFIDENCE = 97
FALLBACK_CLASSIFICATION_CONFIDENCE = 50
RULE_BASED_CLASSIFICATION_CONFIDENCE = 97


class OutreachItemCreate(BaseModel):
    model_config = ConfigDict(extra="allow")

    to: Optional[str] = None
    name: str = Field(..., min_length=1)
    company: str = Field(..., min_length=1)
    role: Optional[str] = ""
    subject: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)
    response_type: Literal["email", "proposal", "whitepaper", "followup"] = "email"
    contact_message: Optional[str] = ""
    classification_confidence: Optional[int] = Field(None, ge=0, le=MAX_CLASSIFICATION_CONFIDENCE)
    score: int = Field(FALLBACK_CLASSIFICATION_CONFIDENCE, ge=0, le=100)
    campaign_id: Optional[str] = ""
    opportunity_id: Optional[str] = ""


class GenerateResponseRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    contact_message: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    company: str = Field(..., min_length=1)
    role: Optional[str] = ""
    campaign_id: Optional[str] = ""


class ProposalFollowUpsRequest(BaseModel):
    limit: int = Field(10, ge=1, le=25)


class CampaignOpportunity(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: Optional[str] = ""
    company: str = ""
    contact: Optional[str] = ""
    role: Optional[str] = ""
    industry: Optional[str] = ""
    score: int = Field(0, ge=0, le=100)
    stage: Optional[str] = ""


class CampaignAsset(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: Optional[str] = ""
    title: str = ""
    type: Optional[str] = ""


class GenerateFromCampaignRequest(BaseModel):
    campaign_id: Optional[str] = ""
    campaign_name: str = ""
    objective: str = "lead_generation"
    channels: list[str] = Field(default_factory=list)
    context: Optional[str] = ""
    opportunities: list[CampaignOpportunity] = Field(default_factory=list)
    assets: list[CampaignAsset] = Field(default_factory=list)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_json(raw_content: str) -> dict:
    cleaned = re.sub(r"```(?:json)?\s*", "", raw_content or "").strip().rstrip("`").strip()
    return json.loads(cleaned)


def _normalize_classification_confidence(value: object, fallback: int = FALLBACK_CLASSIFICATION_CONFIDENCE) -> int:
    try:
        confidence = int(float(value))
    except (TypeError, ValueError):
        confidence = fallback
    return min(MAX_CLASSIFICATION_CONFIDENCE, max(0, confidence))


def _classification_confidence_from_payload(payload: dict, fallback: int = FALLBACK_CLASSIFICATION_CONFIDENCE) -> int:
    return _normalize_classification_confidence(
        payload.get("classification_confidence", payload.get("confidence")),
        fallback=fallback,
    )


def _with_classification_confidence_alias(payload: dict, confidence: int) -> dict:
    normalized = _normalize_classification_confidence(confidence)
    return {
        **payload,
        "classification_confidence": normalized,
        "score": normalized,
    }


def _assert_owner(item: dict, user_id: str) -> None:
    if item.get("userId") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")


async def _get_outreach_item_for_user(item_id: str, user_id: str) -> dict:
    try:
        item = await outreach_repo.get_or_404(item_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Outreach item '{item_id}' not found.",
        )
    _assert_owner(item, user_id)
    return item


def _content_prompt(
    *,
    name: str,
    role: str,
    company: str,
    contact_message: str,
    response_type: str,
    original_content: str = "",
) -> str:
    reference = f'\nOriginal content to improve: "{original_content}"\n' if original_content else ""
    return f"""
Write a professional outreach response for {name} ({role} at {company}).
Response type: {response_type}
Their message: "{contact_message}"
{reference}
{"Generate a formal proposal introduction email that transitions to requesting a meeting to present a tailored proposal. Be specific about NoonDalton's AI marketing automation capabilities." if response_type == "proposal" else ""}
{"Generate an email with relevant technical insights about AI marketing automation, offering to share a detailed case study." if response_type == "whitepaper" else ""}
{"Generate a warm follow-up email that nurtures the relationship and offers a specific next step." if response_type == "followup" else ""}
{"Generate a professional acknowledgment and response to their inquiry." if response_type == "email" else ""}

Rules:
- Maximum 4 paragraphs
- Professional but conversational tone
- End with a clear call to action
- Do NOT include subject line in the body
- Sign as NoonDalton AI Marketing Team
"""


def _proposal_contact_fields(proposal: dict) -> dict:
    structured = proposal.get("structured_content") or proposal.get("structuredContent") or {}
    company = (
        proposal.get("clientName")
        or proposal.get("customerName")
        or proposal.get("customer_name")
        or structured.get("client")
        or proposal.get("company")
        or "Client"
    )
    contact = (
        structured.get("contact")
        or proposal.get("contact")
        or proposal.get("contactName")
        or company
    )
    title = proposal.get("title") or proposal.get("name") or "Proposal"
    amount = proposal.get("totalAmount") or proposal.get("total_amount") or proposal.get("total") or structured.get("totalAmount") or 0
    return {
        "company": str(company),
        "contact": str(contact),
        "title": str(title),
        "amount": amount,
    }


async def _classify_response_type(body: GenerateResponseRequest) -> dict:
    classification_prompt = f"""
Analyze this message from {body.name} ({body.role or ""} at {body.company}) and classify the response type needed.
Message: "{body.contact_message}"

Respond with ONLY a JSON object:
{{
  "response_type": "proposal" | "email" | "whitepaper" | "followup",
  "reasoning": "one sentence explanation",
  "subject": "suggested email subject line",
  "classification_confidence": integer 0-97
}}

Rules:
- "proposal": contact expressed clear interest and wants pricing or a formal offer
- "whitepaper": contact wants more technical information or case studies
- "followup": contact showed mild interest or asked a general question
- "email": any other response or acknowledgment needed
- "classification_confidence" is confidence that the response_type classification is correct.
- It is NOT engagement score, deal score, pipeline progress, or likelihood to close.
- Never return 98, 99, or 100 for classification_confidence.
"""
    raw = await deepseek_service.generate_text(
        classification_prompt,
        system_prompt="You classify B2B outreach replies and return strict JSON.",
        temperature=0.2,
        timeout=settings.llm_short_timeout_seconds,
    )
    try:
        payload = _safe_json(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        payload = {}

    response_type = payload.get("response_type")
    if response_type not in RESPONSE_TYPES:
        response_type = "email"
    subject = str(payload.get("subject") or f"Re: {body.company} and NoonDalton").strip()
    return {
        "response_type": response_type,
        "reasoning": str(payload.get("reasoning") or "").strip(),
        "subject": subject,
        "classification_confidence": _classification_confidence_from_payload(payload),
    }


async def _generate_content(
    *,
    name: str,
    role: str,
    company: str,
    contact_message: str,
    response_type: str,
    original_content: str = "",
) -> str:
    return await deepseek_service.generate_text(
        _content_prompt(
            name=name,
            role=role,
            company=company,
            contact_message=contact_message,
            response_type=response_type,
            original_content=original_content,
        ),
        system_prompt="You write concise professional B2B outreach responses.",
        temperature=0.7,
        timeout=settings.llm_default_timeout_seconds,
    )


async def _list_for_user(user_id: str, statuses: set[str] | None = None) -> list[dict]:
    filters = [("userId", "==", user_id)]
    items = await outreach_repo.list(filters=filters, order_by="created_at", limit=500)
    if statuses:
        items = [item for item in items if item.get("status") in statuses]
    return items


@router.get("")
async def get_outreach(current_user: CurrentUser = Depends(get_current_user)):
    items = await _list_for_user(current_user.sub)
    return {
        "reviewQueue": [item for item in items if item.get("status") == "pending"],
        "history": [item for item in items if item.get("status") in {"sent", "rejected"}],
    }


@router.get("/review-queue")
async def get_review_queue(current_user: CurrentUser = Depends(get_current_user)):
    return await _list_for_user(current_user.sub, {"pending"})


@router.post("/review-queue", status_code=status.HTTP_201_CREATED)
async def create_review_queue_item(
    body: OutreachItemCreate,
    current_user: CurrentUser = Depends(get_current_user),
):
    data = body.model_dump(mode="json")
    now = _now()
    payload = {
        **data,
        "userId": current_user.sub,
        "to": data.get("to") or data["name"],
        "status": "pending",
        "created_at": now,
        "sent_at": None,
    }
    confidence = _normalize_classification_confidence(data.get("classification_confidence", data.get("score")))
    payload = _with_classification_confidence_alias(payload, confidence)
    return await outreach_repo.create(payload)


@router.post("/review-queue/generate-response", status_code=status.HTTP_201_CREATED)
@limiter.limit("20/minute")
async def generate_response(
    request: Request,
    body: GenerateResponseRequest,
    current_user: CurrentUser = Depends(get_current_user),
):
    classification = await _classify_response_type(body)
    content = await _generate_content(
        name=body.name,
        role=body.role or "",
        company=body.company,
        contact_message=body.contact_message,
        response_type=classification["response_type"],
    )
    now = _now()
    confidence = classification["classification_confidence"]
    payload = _with_classification_confidence_alias({
        "userId": current_user.sub,
        "to": body.name,
        "name": body.name,
        "company": body.company,
        "role": body.role or "",
        "subject": classification["subject"],
        "content": content,
        "response_type": classification["response_type"],
        "contact_message": body.contact_message,
        "status": "pending",
        "campaign_id": body.campaign_id or "",
        "opportunity_id": "",
        "created_at": now,
        "sent_at": None,
        "reasoning": classification["reasoning"],
    }, confidence)
    return await outreach_repo.create(payload)


@router.post("/generate-from-campaign", status_code=status.HTTP_201_CREATED)
@limiter.limit("10/minute")
async def generate_from_campaign(
    request: Request,
    body: GenerateFromCampaignRequest,
    current_user: CurrentUser = Depends(get_current_user),
):
    created = []
    assets = [asset.model_dump(mode="json") for asset in body.assets]
    asset_titles = [asset.get("title") for asset in assets if asset.get("title")]
    primary_channel = body.channels[0] if body.channels else "email"

    for opportunity in body.opportunities:
        company = opportunity.company or "the prospect"
        contact = opportunity.contact or company
        role = opportunity.role or "Decision Maker"
        stage = opportunity.stage or "Detected"
        industry = opportunity.industry or "General"
        score = opportunity.score or 0
        prompt = f"""
Generate a personalized outreach message for {contact} ({role} at {company}).

Campaign objective: {body.objective}
Campaign context: {body.context or ""}
Primary channel: {primary_channel}
Available assets to reference: {", ".join(asset_titles) if asset_titles else "None"}
Prospect stage: {stage} (score: {score}%)
Industry: {industry}

Generate a professional, personalized message that:
1. Opens with a specific reference to {company}'s context or industry
2. Clearly states the value proposition aligned with {body.objective}
3. References the most relevant asset if available
4. Ends with a clear, low-friction call to action
5. Is appropriate for {primary_channel} channel
6. Maximum 150 words

Respond with JSON only:
{{
  "subject": "email subject line or linkedin message title",
  "content": "the full message body",
  "response_type": "email" or "followup" or "proposal",
  "classification_confidence": integer 0-97
}}

"classification_confidence" is confidence that response_type is correct for this message.
It is NOT engagement score, opportunity score, pipeline progress, or likelihood to close.
Never return 98, 99, or 100 for classification_confidence.
"""
        raw = await deepseek_service.generate_text(
            prompt,
            system_prompt="You generate personalized B2B outreach and return strict JSON.",
            temperature=0.7,
            timeout=settings.llm_short_timeout_seconds,
        )
        try:
            generated = _safe_json(raw)
        except (json.JSONDecodeError, TypeError, ValueError):
            generated = {
                "subject": f"{company} and NoonDalton",
                "content": str(raw or "").strip(),
                "response_type": "email",
                "classification_confidence": FALLBACK_CLASSIFICATION_CONFIDENCE,
            }

        response_type = generated.get("response_type")
        if response_type not in {"email", "followup", "proposal"}:
            response_type = "email"
        classification_confidence = _classification_confidence_from_payload(generated)

        payload = _with_classification_confidence_alias({
            "userId": current_user.sub,
            "to": contact,
            "name": contact,
            "company": company,
            "role": role,
            "subject": str(generated.get("subject") or f"{company} and NoonDalton").strip(),
            "content": str(generated.get("content") or "").strip(),
            "response_type": response_type,
            "contact_message": body.context or body.objective,
            "status": "pending",
            "campaign_id": body.campaign_id or "",
            "campaign_name": body.campaign_name,
            "opportunity_id": opportunity.id or "",
            "contentRef": asset_titles[0] if asset_titles else "",
            "assets": assets,
            "created_at": _now(),
            "sent_at": None,
        }, classification_confidence)
        created.append(await outreach_repo.create(payload))

    return {"items": created, "count": len(created)}


@router.post("/review-queue/proposal-followups")
@limiter.limit("20/minute")
async def create_proposal_followups(
    request: Request,
    body: ProposalFollowUpsRequest,
    current_user: CurrentUser = Depends(get_current_user),
):
    proposals = await proposals_repo.list(
        filters=[("userId", "==", current_user.sub)],
        order_by="createdAt",
        order_direction="DESCENDING",
        limit=500,
    )
    negotiation_proposals = [
        proposal
        for proposal in proposals
        if proposal.get("proposal_status") == "En Negociación"
    ][: body.limit]

    existing_items = await _list_for_user(current_user.sub, {"pending"})
    existing_by_proposal_id = {
        item.get("proposal_id"): item
        for item in existing_items
        if item.get("response_type") == "followup" and item.get("proposal_id")
    }

    created = []
    reused = []
    now = _now()
    for proposal in negotiation_proposals:
        proposal_id = proposal.get("id")
        if proposal_id and proposal_id in existing_by_proposal_id:
            reused.append(existing_by_proposal_id[proposal_id])
            continue

        fields = _proposal_contact_fields(proposal)
        amount_text = f"${float(fields['amount']):,.0f}" if fields.get("amount") else "the current proposal value"
        contact_message = (
            f"Create a follow-up for the proposal '{fields['title']}' for {fields['company']}. "
            f"The proposal is currently in negotiation with an estimated value of {amount_text}. "
            "Reference the proposal context, reinforce the business value, and ask for a concrete next step."
        )
        content = await _generate_content(
            name=fields["contact"],
            role="Decision Maker",
            company=fields["company"],
            contact_message=contact_message,
            response_type="followup",
        )
        reasoning = "Response type determined by proposal-followup workflow rules."
        payload = _with_classification_confidence_alias({
            "userId": current_user.sub,
            "to": fields["contact"],
            "name": fields["contact"],
            "company": fields["company"],
            "role": "Decision Maker",
            "subject": f"Follow-up on {fields['title']}",
            "content": content,
            "response_type": "followup",
            "contact_message": contact_message,
            "status": "pending",
            "campaign_id": "",
            "opportunity_id": proposal.get("opportunity_id") or "",
            "proposal_id": proposal_id or "",
            "proposal_title": fields["title"],
            "contentRef": fields["title"],
            "created_at": now,
            "sent_at": None,
            "reasoning": reasoning,
        }, RULE_BASED_CLASSIFICATION_CONFIDENCE)
        created.append(await outreach_repo.create(payload))

    return {
        "created": created,
        "reused": reused,
        "items": [*created, *reused],
        "count": len(created) + len(reused),
        "createdCount": len(created),
        "reusedCount": len(reused),
        "proposalCount": len(negotiation_proposals),
    }


@router.patch("/review-queue/{item_id}/approve")
async def approve_review_queue_item(
    item_id: str,
    current_user: CurrentUser = Depends(get_current_user),
):
    await _get_outreach_item_for_user(item_id, current_user.sub)
    return await outreach_repo.update(item_id, {
        "status": "sent",
        "sent_at": _now(),
        "approvedBy": current_user.sub,
        "approvedByName": current_user.name or current_user.email or current_user.sub,
    })


@router.patch("/review-queue/{item_id}/reject")
async def reject_review_queue_item(
    item_id: str,
    current_user: CurrentUser = Depends(get_current_user),
):
    await _get_outreach_item_for_user(item_id, current_user.sub)
    return await outreach_repo.update(item_id, {
        "status": "rejected",
        "rejectedAt": _now(),
        "rejectedBy": current_user.sub,
        "rejectedByName": current_user.name or current_user.email or current_user.sub,
    })


@router.patch("/review-queue/{item_id}/regenerate")
@limiter.limit("20/minute")
async def regenerate_review_queue_item(
    request: Request,
    item_id: str,
    current_user: CurrentUser = Depends(get_current_user),
):
    item = await _get_outreach_item_for_user(item_id, current_user.sub)
    content = await _generate_content(
        name=item.get("name") or item.get("to") or "",
        role=item.get("role") or "",
        company=item.get("company") or "",
        contact_message=item.get("contact_message") or "",
        response_type=item.get("response_type") or "email",
        original_content=item.get("content") or "",
    )
    return await outreach_repo.update(item_id, {"content": content})


@router.get("/history")
async def get_outreach_history(current_user: CurrentUser = Depends(get_current_user)):
    return await _list_for_user(current_user.sub, {"sent", "rejected"})


@router.delete("/history/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_outreach_history_item(
    item_id: str,
    current_user: CurrentUser = Depends(get_current_user),
):
    await _get_outreach_item_for_user(item_id, current_user.sub)
    await outreach_repo.delete(item_id)


@router.patch("/history/{item_id}/restore")
async def restore_outreach_history_item(
    item_id: str,
    current_user: CurrentUser = Depends(get_current_user),
):
    await _get_outreach_item_for_user(item_id, current_user.sub)
    return await outreach_repo.update(item_id, {"status": "pending", "sent_at": None})
