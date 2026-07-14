"""Customers router — CRM-lite CRUD + CSV import."""
from __future__ import annotations

import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File

from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.customer import (
    CustomerCreate, CustomerUpdate, CustomerOut, CustomerListResponse,
)
from app.services.firestore_service import customers_repo

router = APIRouter(prefix="/customers", tags=["Customers"])


def _assert_owner(customer: dict, user: CurrentUser) -> None:
    if customer.get("userId") != user.sub:
        raise HTTPException(status_code=403, detail="Access denied.")


async def _get_customer_for_user(customer_id: str, user: CurrentUser) -> dict:
    customer = await customers_repo.get(customer_id)
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found.")
    _assert_owner(customer, user)
    return customer


# ── List ──────────────────────────────────────────────────────────────────────
@router.get("", response_model=CustomerListResponse)
async def list_customers(
    search: Optional[str] = Query(None),
    limit:  int           = Query(20, ge=1, le=100),
    offset: int           = Query(0, ge=0),
    user:   CurrentUser   = Depends(get_current_user),
):
    customers = await customers_repo.list(
        filters=[("userId", "==", user.sub)],
        order_by="createdAt", order_direction="DESCENDING",
        limit=limit, offset=offset,
    )
    if search:
        s = search.lower()
        customers = [
            c for c in customers
            if s in c.get("name", "").lower()
            or s in c.get("email", "").lower()
            or s in (c.get("company") or "").lower()
        ]
    total = await customers_repo.count(filters=[("userId", "==", user.sub)])
    return CustomerListResponse(items=customers, total=total)


# ── Create ────────────────────────────────────────────────────────────────────
@router.post("", response_model=CustomerOut, status_code=201)
async def create_customer(
    body: CustomerCreate,
    user: CurrentUser = Depends(get_current_user),
):
    data = body.model_dump()
    data["userId"] = user.sub
    return await customers_repo.create(data)


# ── Get one ───────────────────────────────────────────────────────────────────
@router.get("/{customer_id}", response_model=CustomerOut)
async def get_customer(
    customer_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    return await _get_customer_for_user(customer_id, user)


# ── Update ────────────────────────────────────────────────────────────────────
@router.put("/{customer_id}", response_model=CustomerOut)
async def update_customer(
    customer_id: str,
    body: CustomerUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    await _get_customer_for_user(customer_id, user)
    return await customers_repo.update(customer_id, body.model_dump(exclude_none=True))


# ── Delete ────────────────────────────────────────────────────────────────────
@router.delete("/{customer_id}", status_code=204)
async def delete_customer(
    customer_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    await _get_customer_for_user(customer_id, user)
    await customers_repo.delete(customer_id)


# ── CSV import ────────────────────────────────────────────────────────────────
@router.post("/import", status_code=200)
async def import_customers_csv(
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
):
    """
    Import customers from a CSV file.
    Expected columns: name, email, company (optional), phone (optional), notes (optional)
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
        row = {k.strip().lower(): v.strip() for k, v in row.items()}
        missing = required - set(row.keys())
        if missing:
            errors.append(f"Row {i + 2}: missing fields {missing}")
            continue
        if not row.get("name") or not row.get("email"):
            errors.append(f"Row {i + 2}: empty name or email, skipped.")
            continue
        try:
            await customers_repo.create({
                "userId":  user.sub,
                "name":    row["name"],
                "email":   row["email"],
                "company": row.get("company") or None,
                "phone":   row.get("phone") or None,
                "notes":   row.get("notes") or None,
            })
            imported += 1
        except Exception as e:
            errors.append(f"Row {i + 2}: {str(e)}")

    return {"imported": imported, "errors": errors}
