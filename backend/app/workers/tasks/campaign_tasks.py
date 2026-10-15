"""
Celery tasks for campaign content generation.

Tasks:
  task_generate_campaign_content — Generate campaign posts using DeepSeek in background worker.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from celery import Task

from app.workers.celery_app import celery_app
from app.services import deepseek_service
from app.services.firestore_service import assets_repo, campaigns_repo, jobs_repo

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


async def generate_campaign_content_now(
    job_id: str,
    campaign_id: str,
    asset_id: str,
    user_id: str,
) -> dict:
    """Generate campaign content and update Firestore.
    Shared by the Celery task and synchronous fallback.
    """
    await jobs_repo.update_progress(job_id, 20)
    await campaigns_repo.update(campaign_id, {
        "aiGeneration": {
            "status": "generating",
            "jobId": job_id,
            "assetId": asset_id,
        },
    })

    campaign = await campaigns_repo.get_or_404(campaign_id)
    channels = campaign.get("channels") or ["linkedin"]
    generated_content = await _generate_campaign_content(campaign, channels)

    await jobs_repo.update_progress(job_id, 80)
    asset = await assets_repo.update(asset_id, {
        "status": "ready",
        "content": json.dumps(generated_content, ensure_ascii=False),
        "mimeType": "application/json",
    })
    await campaigns_repo.update(campaign_id, {
        "aiGeneration": {
            "status": "ready",
            "jobId": job_id,
            "assetId": asset_id,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
    })
    result = {
        "campaignId": campaign_id,
        "jobId": job_id,
        "assetId": asset_id,
        "asset": asset,
    }
    await jobs_repo.complete_job(job_id, result)
    logger.info("campaign content done: job=%s campaign=%s", job_id, campaign_id)
    return result


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10, queue="llm")
def task_generate_campaign_content(
    self: Task,
    job_id: str,
    campaign_id: str,
    asset_id: str,
    user_id: str,
):
    """Generate campaign content via background Celery task."""
    try:
        _run(generate_campaign_content_now(job_id, campaign_id, asset_id, user_id))
    except Exception as exc:
        logger.exception("task_generate_campaign_content failed: job=%s campaign=%s", job_id, campaign_id)
        _run(assets_repo.update(asset_id, {"status": "error"}))
        _run(campaigns_repo.update(campaign_id, {
            "aiGeneration": {
                "status": "error",
                "jobId": job_id,
                "assetId": asset_id,
                "error": str(exc),
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            },
        }))
        _run(jobs_repo.fail_job(job_id, str(exc)))
        raise self.retry(exc=exc)
