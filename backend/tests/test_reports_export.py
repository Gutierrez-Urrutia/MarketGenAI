from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import fake_book


@pytest.mark.asyncio
async def test_reports_export_pdf_returns_valid_pdf(client):
    with patch(
        "app.routers.reports.books_repo.list",
        new_callable=AsyncMock,
        return_value=[fake_book({"title": "Retail Automation Playbook"})],
    ):
        resp = await client.get("/api/v1/reports/export?format=pdf")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.content.startswith(b"%PDF")
    assert len(resp.content) > 1000
