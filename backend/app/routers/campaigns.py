"""Campaigns router - authenticated Firestore CRUD and AI generation."""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.config import settings
from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.campaign import CampaignCreate, CampaignOut, CampaignStatus, CampaignUpdate
from app.services import deepseek_service
from app.services.firestore_service import assets_repo, campaigns_repo, jobs_repo

router = APIRouter(prefix="/campaigns", tags=["Campaigns"])
logger = logging.getLogger(__name__)

CAMPAIGN_OBJECTIVE_LABELS = {
    "lead_generation": "Lead generation - drive qualified prospects to engage.",
    "awareness": "Brand awareness - introduce the offering to a new audience.",
    "follow_up": "Follow-up and nurture - re-engage prospects already in conversation.",
    "conversion": "Conversion - move warm prospects toward a decision.",
}

CAMPAIGN_CHANNEL_RULES = {
    "linkedin": "Write a professional LinkedIn post with a clear hook, useful insight, CTA, and 3-5 relevant hashtags.",
    "substack": "Write a concise newsletter draft with a subject line, opening hook, useful body, and CTA.",
    "email_outreach": "Write a personalized cold outreach email with a subject line, short body, clear value proposition, and low-friction CTA.",
}


def _parse_campaign_posts(raw_content: str, channels: list[str]) -> list[dict]:
    cleaned = re.sub(r"```(?:json)?\s*", "", raw_content).strip().rstrip("`").strip()
    payload = json.loads(cleaned)
    posts = payload.get("posts") if isinstance(payload, dict) else None
    if not isinstance(posts, list):
        raise ValueError("DeepSeek response must contain a posts list.")

    normalized = []
    for post in posts:
        if not isinstance(post, dict):
            continue
        channel = str(post.get("channel") or "").strip()
        if channel not in channels:
            continue
        content = str(post.get("content") or "").strip()
        if not content:
            continue
        hashtags = post.get("hashtags") or []
        if not isinstance(hashtags, list):
            hashtags = [hashtags]
        normalized.append({
            "channel": channel,
            "headline": str(post.get("headline") or "").strip(),
            "content": content,
            "hashtags": [str(tag).strip() for tag in hashtags if str(tag).strip()],
        })

    if len(normalized) != len(channels) or {post["channel"] for post in normalized} != set(channels):
        raise ValueError("DeepSeek response must contain one valid post per campaign channel.")
    return normalized


def _campaign_posts_prompt(campaign: dict, channels: list[str], retry: bool = False) -> str:
    objective = campaign.get("objective", "")
    objective_label = CAMPAIGN_OBJECTIVE_LABELS.get(objective, objective or "Lead generation")
    channel_rules = "\n".join(
        f"- {channel}: {CAMPAIGN_CHANNEL_RULES.get(channel, 'Write clear, persuasive copy with a strong call to action.')}"
        for channel in channels
    )
    retry_instruction = "Your previous response was invalid. Return valid JSON only." if retry else ""
    return f"""Create one B2B marketing post for every requested campaign channel.

Campaign: {campaign["name"]}
Target audience: {campaign.get("audience") or "Not specified"}
Objective: {objective_label}
Context: {campaign.get("context") or "Not specified"}
Channels and requirements:
{channel_rules}

Return strict JSON only, without markdown fences or commentary, using exactly:
{{"posts":[{{"channel":"linkedin","headline":"...","content":"...","hashtags":["#tag"]}}]}}

Include exactly one post for each channel: {", ".join(channels)}.
{retry_instruction}
"""


async def _generate_campaign_content(campaign: dict, channels: list[str]) -> dict:
    last_response = ""
    for attempt in range(2):
        last_response = await deepseek_service.generate_text(
            _campaign_posts_prompt(campaign, channels, retry=attempt == 1),
            system_prompt="You are an expert B2B marketing copywriter.",
            timeout=None,
        )
        try:
            return {"posts": _parse_campaign_posts(last_response, channels)}
        except (json.JSONDecodeError, ValueError, TypeError):
            logger.exception(
                "Invalid structured campaign content from DeepSeek: campaign=%s attempt=%s",
                campaign.get("id"),
                attempt + 1,
            )

    fallback_text = last_response.strip()
    return {
        "posts": [
            {
                "channel": channel,
                "headline": campaign.get("name", ""),
                "content": fallback_text,
                "hashtags": [],
            }
            for channel in channels
        ]
    }


def _assert_owner(campaign: dict, user_id: str) -> None:
    if campaign.get("userId") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")


async def _get_campaign_for_user(campaign_id: str, user_id: str) -> dict:
    try:
        campaign = await campaigns_repo.get_or_404(campaign_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Campaign '{campaign_id}' not found.",
        )
    _assert_owner(campaign, user_id)
    return campaign


@router.get("", response_model=List[CampaignOut])
async def get_campaigns(
    search: Optional[str] = Query(None, description="Partial search in campaign name"),
    status_filter: Optional[CampaignStatus] = Query(None, alias="status"),
    limit: int = Query(200, ge=1, le=500),
    user: CurrentUser = Depends(get_current_user),
):
    filters = [("userId", "==", user.sub)]
    if status_filter:
        filters.append(("status", "==", status_filter.value))

    campaigns = await campaigns_repo.list(
        filters=filters,
        order_by="updatedAt",
        order_direction="DESCENDING",
        limit=limit,
    )
    if search:
        normalized_search = search.lower()
        campaigns = [
            campaign
            for campaign in campaigns
            if normalized_search in (campaign.get("name") or "").lower()
        ]
    return campaigns


@router.post("", response_model=CampaignOut, status_code=status.HTTP_201_CREATED)
async def create_campaign(
    body: CampaignCreate,
    user: CurrentUser = Depends(get_current_user),
):
    data = body.model_dump(mode="json")
    data["userId"] = user.sub
    return await campaigns_repo.create(data)


@router.post("/{campaign_id}/generate", status_code=status.HTTP_201_CREATED)
async def generate_campaign_content(
    campaign_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Generate campaign content synchronously so it also works on serverless hosts."""
    campaign = await _get_campaign_for_user(campaign_id, user.sub)
    channels = campaign.get("channels") or ["linkedin"]
    asset = await assets_repo.create({
        "type": "campaign_content",
        "campaignId": campaign["id"],
        "campaignName": campaign["name"],
        "userId": user.sub,
        "status": "generating",
        "title": f"AI Campaign Content - {campaign['name']}",
        "channel": channels[0],
        "objective": campaign.get("objective", ""),
    })
    job = await jobs_repo.create_job(
        "campaign_content_generation",
        user.sub,
        {"campaignId": campaign["id"], "assetId": asset["id"]},
    )

    try:
        await jobs_repo.update_progress(job["id"], 20)
        await campaigns_repo.update(campaign["id"], {
            "aiGeneration": {
                "status": "generating",
                "jobId": job["id"],
                "assetId": asset["id"],
            },
        })
        generated_content = await _generate_campaign_content(campaign, channels)
        await jobs_repo.update_progress(job["id"], 80)
        asset = await assets_repo.update(asset["id"], {
            "status": "ready",
            "content": json.dumps(generated_content, ensure_ascii=False),
            "mimeType": "application/json",
        })
        await campaigns_repo.update(campaign["id"], {
            "aiGeneration": {
                "status": "ready",
                "jobId": job["id"],
                "assetId": asset["id"],
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            },
        })
        await jobs_repo.complete_job(job["id"], {
            "campaignId": campaign["id"],
            "assetId": asset["id"],
        })
        return {"campaignId": campaign["id"], "jobId": job["id"], "asset": asset}
    except Exception as exc:
        logger.exception("Campaign AI content generation failed: campaign=%s", campaign["id"])
        await assets_repo.update(asset["id"], {"status": "error"})
        await campaigns_repo.update(campaign["id"], {
            "aiGeneration": {
                "status": "error",
                "jobId": job["id"],
                "assetId": asset["id"],
                "error": str(exc),
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            },
        })
        await jobs_repo.fail_job(job["id"], str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Campaign was saved, but AI content generation failed.",
        )


@router.get("/{campaign_id}", response_model=CampaignOut)
async def get_campaign(
    campaign_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    return await _get_campaign_for_user(campaign_id, user.sub)


@router.put("/{campaign_id}", response_model=CampaignOut)
async def update_campaign(
    campaign_id: str,
    body: CampaignUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    await _get_campaign_for_user(campaign_id, user.sub)
    update_data = body.model_dump(exclude_none=True, mode="json")
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update.",
        )
    return await campaigns_repo.update(campaign_id, update_data)


@router.delete("/{campaign_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_campaign(
    campaign_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    await _get_campaign_for_user(campaign_id, user.sub)
    await campaigns_repo.delete(campaign_id)
    return None
