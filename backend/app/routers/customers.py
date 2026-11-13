"""Customers router — CRM-lite CRUD + CSV import + perfil (industria y tamaño) e historial (RF-VTA-03)."""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile

from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.customer import (
    CustomerCreate, CustomerUpdate, CustomerOut, CustomerListResponse,
    CustomerProposalOut, CustomerProposalsResponse,
)
from app.services.customer_profile_service import (
    industry_label, parse_industry, parse_size, profile_options, size_label,
)
from app.services.firestore_service import customers_repo, proposals_repo

router = APIRouter(prefix="/customers", tags=["Customers"])

_EPOCH = datetime.min.replace(tzinfo=timezone.utc)


def _assert_owner(customer: dict, user: CurrentUser) -> None:
    if customer.get("userId") != user.sub:
        raise HTTPException(status_code=403, detail="Access denied.")


async def _get_customer_for_user(customer_id: str, user: CurrentUser) -> dict:
    customer = await customers_repo.get(customer_id)
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found.")
    _assert_owner(customer, user)
    return customer


def _present(customer: Dict[str, Any], language: Optional[str]) -> Dict[str, Any]:
    """Agrega las etiquetas de industria y tamaño en el idioma pedido (Accept-Language, por defecto es)."""
    return {
        **customer,
        "industryLabel": industry_label(customer.get("industry"), language),
        "sizeLabel": size_label(customer.get("size"), language),
    }


def _created_at(doc: Dict[str, Any]) -> datetime:
    value = doc.get("createdAt")
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return _EPOCH


# ── Options (industrias y tamaños para los selectores) ────────────────────────
@router.get("/options")
async def customer_options(user: CurrentUser = Depends(get_current_user)):
    return profile_options()


# ── List ──────────────────────────────────────────────────────────────────────
@router.get("", response_model=CustomerListResponse)
async def list_customers(
    search:   Optional[str] = Query(None),
    industry: Optional[str] = Query(None),
    size:     Optional[str] = Query(None),
    limit:    int           = Query(20, ge=1, le=100),
    offset:   int           = Query(0, ge=0),
    user:     CurrentUser   = Depends(get_current_user),
    accept_language: Optional[str] = Header(None),
):
    filters = [("userId", "==", user.sub)]
    try:
        industry_code = parse_industry(industry)
        size_code = parse_size(size)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if industry_code:
        filters.append(("industry", "==", industry_code))
    if size_code:
        filters.append(("size", "==", size_code))

    # Los clientes de un usuario son pocos: se carga el conjunto filtrado, y se busca, ordena
    # y pagina aquí (Firestore no busca por texto, y paginar antes de buscar perdía resultados).
    customers = await customers_repo.list(filters=filters, limit=0)
    if search:
        s = search.strip().lower()
        customers = [
            c for c in customers
            if s in (c.get("name") or "").lower()
            or s in (c.get("email") or "").lower()
            or s in (c.get("company") or "").lower()
        ]
    customers.sort(key=_created_at, reverse=True)
    page = customers[offset:offset + limit]
    return CustomerListResponse(items=[_present(c, accept_language) for c in page], total=len(customers))


# ── Create ────────────────────────────────────────────────────────────────────
@router.post("", response_model=CustomerOut, status_code=201)
async def create_customer(
    body: CustomerCreate,
    user: CurrentUser = Depends(get_current_user),
    accept_language: Optional[str] = Header(None),
):
    data = body.model_dump()
    data["userId"] = user.sub
    return _present(await customers_repo.create(data), accept_language)


# ── Get one ───────────────────────────────────────────────────────────────────
@router.get("/{customer_id}", response_model=CustomerOut)
async def get_customer(
    customer_id: str,
    user: CurrentUser = Depends(get_current_user),
    accept_language: Optional[str] = Header(None),
):
    return _present(await _get_customer_for_user(customer_id, user), accept_language)


# ── Historial de propuestas ───────────────────────────────────────────────────
@router.get("/{customer_id}/proposals", response_model=CustomerProposalsResponse)
async def customer_proposals(
    customer_id: str,
    limit:  int         = Query(20, ge=1, le=100),
    offset: int         = Query(0, ge=0),
    user:   CurrentUser = Depends(get_current_user),
):
    await _get_customer_for_user(customer_id, user)
    proposals = await proposals_repo.list(
        filters=[("userId", "==", user.sub), ("customerId", "==", customer_id)], limit=0,
    )
    proposals.sort(key=_created_at, reverse=True)  # de la más reciente a la más antigua
    page = proposals[offset:offset + limit]
    return CustomerProposalsResponse(
        items=[CustomerProposalOut(**{k: p.get(k) for k in CustomerProposalOut.model_fields}) for p in page],
        total=len(proposals),
    )


# ── Update ────────────────────────────────────────────────────────────────────
@router.put("/{customer_id}", response_model=CustomerOut)
async def update_customer(
    customer_id: str,
    body: CustomerUpdate,
    user: CurrentUser = Depends(get_current_user),
    accept_language: Optional[str] = Header(None),
):
    await _get_customer_for_user(customer_id, user)
    data = body.model_dump(exclude_none=True)
    # industria y tamaño sí se pueden vaciar: enviar "" o null los deja «sin dato».
    for field in ("industry", "size"):
        if field in body.model_fields_set:
            data[field] = getattr(body, field)
    return _present(await customers_repo.update(customer_id, data), accept_language)


# ── Delete ────────────────────────────────────────────────────────────────────
@router.delete("/{customer_id}", status_code=204)
async def delete_customer(
    customer_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    await _get_customer_for_user(customer_id, user)
    count = await proposals_repo.count(filters=[("userId", "==", user.sub), ("customerId", "==", customer_id)])
    if count:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "CUSTOMER_HAS_PROPOSALS",
                "message": f"This customer has {count} proposal(s) and cannot be deleted.",
                "proposalCount": count,
            },
        )
    await customers_repo.delete(customer_id)


# ── CSV import ────────────────────────────────────────────────────────────────
@router.post("/import", status_code=200)
async def import_customers_csv(
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
):
    """
    Import customers from a CSV file.
    Expected columns: name, email, company (optional), phone (optional), notes (optional),
    industry (optional) and size (optional). Industry and size accept the code or the label
    in Spanish, English or Portuguese; an invalid row is reported and the rest keep going.
    """
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are supported.")

    contents = await file.read()
    try:
        reader = csv.DictReader(io.StringIO(contents.decode("utf-8-sig")))
    except Exception:
        raise HTTPException(status_code=400, detail="Could not parse CSV file.")

    required = {"name", "email"}
    headers = {
        header.strip().lower()
        for header in (reader.fieldnames or [])
        if header and header.strip()
    }
    missing_headers = required - headers
    if missing_headers:
        raise HTTPException(
            status_code=422,
            detail=f"CSV is missing required columns: {sorted(missing_headers)}",
        )

    imported = 0
    errors = []

    for i, row in enumerate(reader):
        row = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
        missing = required - set(row.keys())
        if missing:
            errors.append(f"Row {i + 2}: missing fields {missing}")
            continue
        if not row.get("name") or not row.get("email"):
            errors.append(f"Row {i + 2}: empty name or email, skipped.")
            continue
        try:
            industry = parse_industry(row.get("industry"), allow_labels=True)
            size = parse_size(row.get("size"), allow_labels=True)
        except ValueError as exc:
            errors.append(f"Row {i + 2}: {exc}")
            continue
        try:
            await customers_repo.create({
                "userId":  user.sub,
                "name":    row["name"],
                "email":   row["email"],
                "company": row.get("company") or None,
                "phone":   row.get("phone") or None,
                "notes":   row.get("notes") or None,
                "industry": industry,
                "size":     size,
            })
            imported += 1
        except Exception as e:
            errors.append(f"Row {i + 2}: {str(e)}")

    return {"imported": imported, "errors": errors}
