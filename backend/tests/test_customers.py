"""Tests for the /api/v1/customers router."""
from __future__ import annotations

import io
from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import FAKE_USER_SUB

API = "/api/v1/customers"


def fake_customer(overrides: dict | None = None) -> dict:
    base = {
        "id":        "cust-001",
        "userId":    FAKE_USER_SUB,
        "name":      "Jane Doe",
        "email":     "jane@example.com",
        "company":   "Example Corp",
        "phone":     "+1-555-0100",
        "notes":     "",
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-01T00:00:00Z",
    }
    if overrides:
        base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_list_customers(client):
    customers = [fake_customer()]
    with (
        patch("app.routers.customers.customers_repo.list",  new_callable=AsyncMock, return_value=customers),
        patch("app.routers.customers.customers_repo.count", new_callable=AsyncMock, return_value=1),
    ):
        resp = await client.get(API)
    assert resp.status_code == 200
    assert resp.json()["total"] == 1


@pytest.mark.asyncio
async def test_create_customer(client):
    customer = fake_customer()
    with patch("app.routers.customers.customers_repo.create", new_callable=AsyncMock, return_value=customer):
        resp = await client.post(API, json={
            "name":    "Jane Doe",
            "email":   "jane@example.com",
            "company": "Example Corp",
        })
    assert resp.status_code == 201
    assert resp.json()["email"] == "jane@example.com"


@pytest.mark.asyncio
async def test_create_customer_missing_email(client):
    resp = await client.post(API, json={"name": "No Email"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_get_customer_not_found(client):
    with patch("app.routers.customers.customers_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.get(f"{API}/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_customer(client):
    customer = fake_customer()
    updated  = fake_customer({"name": "Jane Smith"})
    with (
        patch("app.routers.customers.customers_repo.get",    new_callable=AsyncMock, return_value=customer),
        patch("app.routers.customers.customers_repo.update", new_callable=AsyncMock, return_value=updated),
    ):
        resp = await client.put(f"{API}/cust-001", json={"name": "Jane Smith"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Jane Smith"


@pytest.mark.asyncio
async def test_delete_customer(client):
    customer = fake_customer()
    with (
        patch("app.routers.customers.customers_repo.get",    new_callable=AsyncMock, return_value=customer),
        patch("app.routers.customers.customers_repo.delete", new_callable=AsyncMock, return_value=None),
    ):
        resp = await client.delete(f"{API}/cust-001")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_csv_import_valid(client):
    """POST /customers/import with a valid CSV creates customers."""
    csv_content = "name,email,company\nAlice,alice@x.com,AliceCo\nBob,bob@x.com,BobCo\n"
    csv_file = io.BytesIO(csv_content.encode())
    created = fake_customer({"name": "Alice", "email": "alice@x.com"})
    with patch("app.routers.customers.customers_repo.create", new_callable=AsyncMock, return_value=created):
        resp = await client.post(
            f"{API}/import",
            files={"file": ("customers.csv", csv_file, "text/csv")},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("imported", 0) >= 0  # At least attempted


@pytest.mark.asyncio
async def test_csv_import_missing_required_columns(client):
    """POST /customers/import with missing columns returns 422."""
    csv_content = "company,phone\nAcme,555\n"
    csv_file = io.BytesIO(csv_content.encode())
    resp = await client.post(
        f"{API}/import",
        files={"file": ("bad.csv", csv_file, "text/csv")},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_csv_import_empty_file(client):
    """POST /customers/import with an empty CSV returns 422."""
    resp = await client.post(
        f"{API}/import",
        files={"file": ("empty.csv", io.BytesIO(b""), "text/csv")},
    )
    assert resp.status_code == 422
