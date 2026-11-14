"""Service catalog router (RF-VTA-02) — company-wide services and service types.

Everyone signed in can read; only manager/admin write. Nothing is deleted:
services and types are deactivated with `active: false`."""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.dependencies.auth import CurrentUser, get_current_user, require_manager
from app.schemas.catalog import (
    ServiceCreate,
    ServiceListResponse,
    ServiceOut,
    ServiceTypeCreate,
    ServiceTypeListResponse,
    ServiceTypeOut,
    ServiceTypeUpdate,
    ServiceUpdate,
    price_to_number,
    validate_price_for_currency,
)
from app.services.firestore_service import (
    DuplicateKeyError,
    UniqueKeyedRepo,
    service_catalog_repo,
    service_types_repo,
)

router = APIRouter(prefix="/catalog", tags=["Catalog"])

DUPLICATE_SERVICE = "A service with the same name and unit already exists."
DUPLICATE_TYPE = "A service type with this name already exists."


def _field_error(field: str, message: str) -> HTTPException:
    """422 shaped like FastAPI's own validation errors, so the client reads one format."""
    return HTTPException(
        status_code=422,
        detail=[{"loc": ["body", field], "msg": message, "type": "value_error"}],
    )


def _service_key(name: str, unit: str) -> str:
    return UniqueKeyedRepo.make_key(name, unit)


def _type_key(name: str) -> str:
    return UniqueKeyedRepo.make_key(name)


async def _types_by_id() -> Dict[str, Dict[str, Any]]:
    types = await service_types_repo.list(limit=0)
    return {t["id"]: t for t in types}


def _with_type_name(service: Dict[str, Any], types: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    return {**service, "typeName": (types.get(service.get("typeId")) or {}).get("name")}


async def _get_service(service_id: str) -> Dict[str, Any]:
    service = await service_catalog_repo.get(service_id)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found.")
    return service


async def _assert_type_usable(type_id: str) -> None:
    service_type = await service_types_repo.get(type_id)
    if not service_type:
        raise _field_error("typeId", "Service type not found.")
    if not service_type.get("active", True):
        raise _field_error("typeId", "Service type is inactive.")


# ── Services ──────────────────────────────────────────────────────────────────
@router.get("/services", response_model=ServiceListResponse)
async def list_services(
    search:  Optional[str]  = Query(None),
    active:  Optional[bool] = Query(None),
    type_id: Optional[str]  = Query(None),
    limit:   int            = Query(20, ge=1, le=100),
    offset:  int            = Query(0, ge=0),
    user:    CurrentUser    = Depends(get_current_user),
):
    filters: List[tuple] = []
    if active is not None:
        filters.append(("active", "==", active))
    if type_id:
        filters.append(("typeId", "==", type_id))

    # The catalog is small and company-wide: load the filtered set, then search,
    # sort and page here (Firestore has no substring search).
    services = await service_catalog_repo.list(filters=filters or None, limit=0)
    if search:
        needle = search.strip().lower()
        services = [s for s in services if needle in (s.get("name") or "").lower()]
    services.sort(key=lambda s: ((s.get("name") or "").lower(), (s.get("unit") or "").lower()))

    types = await _types_by_id()
    page = services[offset:offset + limit]
    return ServiceListResponse(items=[_with_type_name(s, types) for s in page], total=len(services))


@router.get("/services/{service_id}", response_model=ServiceOut)
async def get_service(service_id: str, user: CurrentUser = Depends(get_current_user)):
    service = await _get_service(service_id)
    return _with_type_name(service, await _types_by_id())


@router.post("/services", response_model=ServiceOut, status_code=201)
async def create_service(body: ServiceCreate, user: CurrentUser = Depends(require_manager)):
    await _assert_type_usable(body.typeId)
    data = {
        "name": body.name,
        "description": body.description or "",
        "unit": body.unit,
        "typeId": body.typeId,
        "price": price_to_number(body.price, body.currency),
        "currency": body.currency,
        "conditions": body.conditions or "",
        "active": True,
        "createdBy": user.sub,
        "updatedBy": user.sub,
    }
    try:
        created = await service_catalog_repo.create_unique(data, _service_key(body.name, body.unit))
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail=DUPLICATE_SERVICE)
    return _with_type_name(created, await _types_by_id())


@router.patch("/services/{service_id}", response_model=ServiceOut)
async def update_service(
    service_id: str,
    body: ServiceUpdate,
    request: Request,
    user: CurrentUser = Depends(require_manager),
):
    changes = body.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail="No fields to update.")
    current = await _get_service(service_id)

    if "typeId" in changes and changes["typeId"] != current.get("typeId"):
        await _assert_type_usable(changes["typeId"])

    # Price and currency may arrive separately: validate against what ends up stored.
    if "price" in changes or "currency" in changes:
        currency = changes.get("currency", current["currency"])
        price = changes["price"] if "price" in changes else Decimal(str(current["price"]))
        try:
            validate_price_for_currency(price, currency)
        except ValueError as exc:
            raise _field_error("price", str(exc))
        changes["price"] = price_to_number(price, currency)

    for text_field in ("description", "conditions"):
        if text_field in changes and changes[text_field] is None:
            changes[text_field] = ""

    new_key = None
    if "name" in changes or "unit" in changes:
        new_key = _service_key(changes.get("name", current["name"]), changes.get("unit", current["unit"]))

    if changes.get("active") is False and current.get("active", True):
        request.state.audit_action = "deactivated_service"

    changes["updatedBy"] = user.sub
    try:
        updated = await service_catalog_repo.update_unique(service_id, changes, new_key)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail=DUPLICATE_SERVICE)
    return _with_type_name(updated, await _types_by_id())


# ── Service types ─────────────────────────────────────────────────────────────
@router.get("/service-types", response_model=ServiceTypeListResponse)
async def list_service_types(
    active: Optional[bool] = Query(None),
    user:   CurrentUser    = Depends(get_current_user),
):
    filters = [("active", "==", active)] if active is not None else None
    types = await service_types_repo.list(filters=filters, limit=0)
    types.sort(key=lambda t: (t.get("name") or "").lower())
    return ServiceTypeListResponse(items=types, total=len(types))


@router.post("/service-types", response_model=ServiceTypeOut, status_code=201)
async def create_service_type(body: ServiceTypeCreate, user: CurrentUser = Depends(require_manager)):
    data = {"name": body.name, "active": True, "createdBy": user.sub, "updatedBy": user.sub}
    try:
        return await service_types_repo.create_unique(data, _type_key(body.name))
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail=DUPLICATE_TYPE)


@router.patch("/service-types/{type_id}", response_model=ServiceTypeOut)
async def update_service_type(
    type_id: str,
    body: ServiceTypeUpdate,
    user: CurrentUser = Depends(require_manager),
):
    changes = body.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail="No fields to update.")
    if not await service_types_repo.get(type_id):
        raise HTTPException(status_code=404, detail="Service type not found.")
    changes["updatedBy"] = user.sub
    new_key = _type_key(changes["name"]) if "name" in changes else None
    try:
        return await service_types_repo.update_unique(type_id, changes, new_key)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail=DUPLICATE_TYPE)
