"""Campaigns router - authenticated Firestore CRUD and AI generation."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import List, Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse

from app.config import settings
from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.campaign import (
    CampaignCreate,
    CampaignOut,
    CampaignStatus,
    CampaignUpdate,
    GenerateCampaignRequest,
)
from app.schemas.job import JobAccepted
from app.services import deepseek_service
from app.services.firestore_service import assets_repo, campaigns_repo, jobs_repo
from app.workers.tasks.campaign_tasks import (
    CAMPAIGN_CHANNEL_RULES,
    CAMPAIGN_OBJECTIVE_LABELS,
    _campaign_posts_prompt,
    _generate_campaign_content,
    _parse_campaign_posts,
    generate_campaign_content_now,
    task_generate_campaign_content,
)

router = APIRouter(prefix="/campaigns", tags=["Campaigns"])
logger = logging.getLogger(__name__)


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
    body: Optional[GenerateCampaignRequest] = None,
    user: CurrentUser = Depends(get_current_user),
):
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

    is_sync = getattr(body, "sync", False) if body else False
    if is_sync:
        try:
            return await generate_campaign_content_now(job["id"], campaign["id"], asset["id"], user.sub)
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

    try:
        task_generate_campaign_content.delay(job["id"], campaign["id"], asset["id"], user.sub)
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content={
                "job_id": job["id"],
                "campaign_id": campaign["id"],
                "asset_id": asset["id"],
                "status": "pending",
                "message": "Campaign generation enqueued successfully",
            },
        )
    except Exception as exc:
        logger.warning("Celery dispatch failed: %s; falling back to inline execution for job %s", exc, job["id"])
        try:
            return await generate_campaign_content_now(job["id"], campaign["id"], asset["id"], user.sub)
        except Exception as exc2:
            logger.exception("Campaign AI content generation failed: campaign=%s", campaign["id"])
            await assets_repo.update(asset["id"], {"status": "error"})
            await campaigns_repo.update(campaign["id"], {
                "aiGeneration": {
                    "status": "error",
                    "jobId": job["id"],
                    "assetId": asset["id"],
                    "error": str(exc2),
                    "generatedAt": datetime.now(timezone.utc).isoformat(),
                },
            })
            await jobs_repo.fail_job(job["id"], str(exc2))
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
