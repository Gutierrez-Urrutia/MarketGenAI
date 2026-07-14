"""Platform endpoints used by the web dashboard."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status

from app.dependencies.auth import CurrentUser, get_current_user
from app.routers.content_types import ContentItemsRepo
from app.services.firestore_service import (
    assets_repo,
    books_repo,
    customers_repo,
    proposals_repo,
    settings_repo,
    templates_repo,
)

router = APIRouter(tags=["Platform"])
content_items_repo = ContentItemsRepo()


def _to_iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if value:
        return str(value)
    return None


def _activity_item(kind: str, action: str, item: dict) -> dict:
    title = item.get("title") or item.get("name") or item.get("email") or item.get("id")
    timestamp = item.get("updatedAt") or item.get("createdAt")
    return {
        "id": f"{kind}:{item.get('id', title)}",
        "type": kind,
        "action": action,
        "title": title,
        "status": item.get("status"),
        "timestamp": _to_iso(timestamp),
    }


def _to_match(kind: str, item: dict) -> dict:
    return {
        "id": item.get("id"),
        "type": kind,
        "title": item.get("title") or item.get("name") or item.get("email"),
        "description": item.get("description") or item.get("company") or item.get("status"),
        "updatedAt": _to_iso(item.get("updatedAt") or item.get("createdAt")),
    }


def _matches(item: dict, fields: list[str], query: str) -> bool:
    text = " ".join(str(item.get(field) or "") for field in fields).lower()
    return query in text


def _assert_proposal_owner(proposal: dict, user_id: str) -> None:
    """Raise 403 if the proposal does not belong to the authenticated user."""
    if proposal.get("userId") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")


async def _list_user_and_public_templates(user_id: str, limit: int) -> list[dict]:
    """Return the user's templates plus shared public templates (deduplicated)."""
    user_templates = await templates_repo.list(
        filters=[("userId", "==", user_id)],
        order_by="updatedAt", order_direction="DESCENDING", limit=limit,
    )
    public_templates = await templates_repo.list(
        filters=[("isPublic", "==", True)],
        order_by="updatedAt", order_direction="DESCENDING", limit=limit,
    )
    user_ids = {t["id"] for t in user_templates}
    return user_templates + [t for t in public_templates if t["id"] not in user_ids]


@router.get("/activity")
async def recent_activity(
    limit: int = Query(20, ge=1, le=100),
    user: CurrentUser = Depends(get_current_user),
):
    user_filter = [("userId", "==", user.sub)]
    proposals = await proposals_repo.list(filters=user_filter, order_by="updatedAt", order_direction="DESCENDING", limit=limit)
    books = await books_repo.list(filters=user_filter, order_by="updatedAt", order_direction="DESCENDING", limit=limit)
    customers = await customers_repo.list(filters=user_filter, order_by="updatedAt", order_direction="DESCENDING", limit=limit)
    templates = await _list_user_and_public_templates(user.sub, limit)

    items = (
        [_activity_item("proposal", "updated", item) for item in proposals]
        + [_activity_item("book", "updated", item) for item in books]
        + [_activity_item("customer", "updated", item) for item in customers]
        + [_activity_item("template", "updated", item) for item in templates]
    )
    items.sort(key=lambda item: item.get("timestamp") or "", reverse=True)
    return {"items": items[:limit], "total": len(items)}


@router.get("/search")
async def global_search(
    q: str = Query("", min_length=1),
    limit: int = Query(10, ge=1, le=50),
    user: CurrentUser = Depends(get_current_user),
):
    query = q.lower().strip()
    user_filter = [("userId", "==", user.sub)]

    proposals = await proposals_repo.list(filters=user_filter, limit=200)
    customers = await customers_repo.list(filters=user_filter, limit=200)
    books = await books_repo.list(filters=user_filter, limit=200)
    templates = await _list_user_and_public_templates(user.sub, limit=200)

    results: list[dict] = []
    for kind, docs, fields in (
        ("proposal", proposals, ["title", "clientName", "description", "content"]),
        ("customer", customers, ["name", "email", "company", "notes"]),
        ("template", templates, ["name", "description", "content"]),
        ("book", books, ["title", "description"]),
    ):
        results += [_to_match(kind, item) for item in docs if _matches(item, fields, query)]

    return {"items": results[:limit], "total": len(results)}


@router.get("/content-library")
async def content_library(
    limit: int = Query(50, ge=1, le=200),
    user: CurrentUser = Depends(get_current_user),
):
    user_filter = [("userId", "==", user.sub)]
    proposals = await proposals_repo.list(filters=user_filter, order_by="updatedAt", order_direction="DESCENDING", limit=limit)
    templates = await _list_user_and_public_templates(user.sub, limit)
    assets = await assets_repo.list(filters=user_filter, order_by="updatedAt", order_direction="DESCENDING", limit=limit)
    content_items = await content_items_repo.list(filters=user_filter, order_by="updatedAt", order_direction="DESCENDING", limit=limit)
    content_item_type_labels = {
        "case_study": "Case Study",
        "whitepaper": "Whitepaper",
        "template": "Template",
        "one_pager": "One-Pager",
        "social_post": "Social Post",
    }
    mapped_content_items = [
        {
            "id": item["id"],
            "type": content_item_type_labels.get(item.get("type"), "Template"),
            "name": item.get("title", ""),
            "title": item.get("title", ""),
            "description": item.get("input_data", {}).get("use_case", ""),
            "content": item.get("content", ""),
            "language": item.get("language", "en"),
            # Keep the generation inputs available to the UI.  Social posts use
            # the selected platform to offer the appropriate publish action.
            "inputData": item.get("input_data", {}),
            "variables": item.get("input_data", {}).get("merge_variables", []),
            "usageCount": 0,
            "isPublic": False,
            "createdAt": item.get("created_at") or item.get("createdAt", ""),
            "updatedAt": item.get("updated_at") or item.get("updatedAt", ""),
            "userId": item.get("userId", ""),
            "source": "contentItems",
        }
        for item in content_items
    ]
    return {
        "proposals": proposals,
        "templates": [*templates, *mapped_content_items],
        "assets": assets,
        "total": len(proposals) + len(templates) + len(mapped_content_items) + len(assets),
    }


@router.post("/crm/proposals/{proposal_id}/send")
async def send_proposal_to_crm(
    proposal_id: str,
    payload: dict = Body(default={}),
    user: CurrentUser = Depends(get_current_user),
):
    proposal = await proposals_repo.get(proposal_id)
    if not proposal:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proposal not found")
    _assert_proposal_owner(proposal, user.sub)

    provider = payload.get("provider") or "manual"
    await proposals_repo.update(proposal_id, {
        "crmSync": {
            "provider": provider,
            "status": "queued" if provider != "manual" else "manual_export",
            "syncedAt": datetime.now(timezone.utc),
        }
    })
    return {
        "status": "queued" if provider != "manual" else "manual_export",
        "proposalId": proposal_id,
        "provider": provider,
    }


@router.post("/crm/customers/sync")
async def sync_customers_to_crm(
    payload: dict = Body(default={}),
    user: CurrentUser = Depends(get_current_user),
):
    provider = payload.get("provider") or "manual"
    customers = await customers_repo.list(filters=[("userId", "==", user.sub)], limit=500)
    return {
        "status": "queued" if provider != "manual" else "manual_export",
        "provider": provider,
        "customers": len(customers),
    }


@router.get("/platform/settings")
async def public_platform_settings(user: CurrentUser = Depends(get_current_user)):
    return await settings_repo.get_by_user(user.sub)
