"""Opportunities router - authenticated Firestore CRUD."""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.opportunity import OpportunityCreate, OpportunityOut, OpportunityStage, OpportunityUpdate
from app.services.firestore_service import opportunities_repo

router = APIRouter(prefix="/opportunities", tags=["Opportunities"])

SERVICE_KEYWORDS = [
    "data entry",
    "back office",
    "bpo",
    "finance",
    "accounting",
    "customer service",
    "customer support",
    "virtual assistant",
    "admin",
    "administrative",
    "payroll",
    "invoice",
    "claims",
    "collections",
    "outsourcing",
    "operations",
    "lead generation",
]

STAGE_POINTS = {
    "Detected": 5,
    "Researching": 10,
    "Contacted": 20,
    "Replied": 28,
    "In Conversation": 32,
    "Won": 35,
    "Customer": 35,
    "Lost": 0,
}


def _normalize_keyword(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _compute_score(opportunity: dict) -> int:
    matched_services: set[str] = set()
    keyword_matches = 0
    for raw_keyword in opportunity.get("kw") or []:
        keyword = _normalize_keyword(raw_keyword)
        if len(keyword) < 3:
            continue
        for service in SERVICE_KEYWORDS:
            normalized_service = _normalize_keyword(service)
            if normalized_service in matched_services:
                continue
            if normalized_service in keyword:
                matched_services.add(normalized_service)
                keyword_matches += 1
                break

    keyword_score = min(keyword_matches * 10, 50)
    stage_score = STAGE_POINTS.get(str(opportunity.get("stage") or OpportunityStage.detected.value), 0)

    has_contact = bool(str(opportunity.get("contact") or "").strip())
    has_email = bool(str(opportunity.get("contactEmail") or "").strip())
    contact_score = 15 if has_contact and has_email else 8 if has_contact else 0

    return max(0, min(100, round(keyword_score + stage_score + contact_score)))


def _assert_owner(opportunity: dict, user_id: str) -> None:
    if opportunity.get("userId") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")


async def _get_opportunity_for_user(opportunity_id: str, user_id: str) -> dict:
    try:
        opportunity = await opportunities_repo.get_or_404(opportunity_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Opportunity '{opportunity_id}' not found.",
        )
    _assert_owner(opportunity, user_id)
    return opportunity


def _matches_search(opportunity: dict, search: str) -> bool:
    normalized_search = search.lower()
    searchable = [
        opportunity.get("company"),
        opportunity.get("job"),
        opportunity.get("contact"),
        opportunity.get("role"),
        opportunity.get("source"),
        opportunity.get("content"),
        " ".join(str(keyword) for keyword in opportunity.get("kw") or []),
    ]
    return any(normalized_search in str(value or "").lower() for value in searchable)


@router.get("")
async def get_opportunities(
    stage: Optional[OpportunityStage] = Query(None),
    search: Optional[str] = Query(None, description="Partial search in opportunity fields"),
    limit: int = Query(200, ge=1, le=500),
    user: CurrentUser = Depends(get_current_user),
):
    filters = [("userId", "==", user.sub)]
    if stage:
        filters.append(("stage", "==", stage.value))

    opportunities = await opportunities_repo.list(
        filters=filters,
        order_by="updatedAt",
        order_direction="DESCENDING",
        limit=limit,
    )
    if search:
        opportunities = [
            opportunity
            for opportunity in opportunities
            if _matches_search(opportunity, search)
        ]
    return {"items": opportunities}


@router.post("", response_model=OpportunityOut, status_code=status.HTTP_201_CREATED)
async def create_opportunity(
    body: OpportunityCreate,
    user: CurrentUser = Depends(get_current_user),
):
    data = body.model_dump(mode="json", exclude={"score"})
    data["userId"] = user.sub
    data["score"] = _compute_score(data)
    return await opportunities_repo.create(data)


@router.get("/{opportunity_id}", response_model=OpportunityOut)
async def get_opportunity(
    opportunity_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    return await _get_opportunity_for_user(opportunity_id, user.sub)


@router.put("/{opportunity_id}", response_model=OpportunityOut)
async def update_opportunity(
    opportunity_id: str,
    body: OpportunityUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    current = await _get_opportunity_for_user(opportunity_id, user.sub)
    update_data = body.model_dump(exclude_none=True, mode="json", exclude={"score"})
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update.",
        )
    update_data["score"] = _compute_score({**current, **update_data})
    return await opportunities_repo.update(opportunity_id, update_data)


@router.delete("/{opportunity_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_opportunity(
    opportunity_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    await _get_opportunity_for_user(opportunity_id, user.sub)
    await opportunities_repo.delete(opportunity_id)
    return None
