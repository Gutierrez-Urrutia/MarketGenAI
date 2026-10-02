"""Tests for the /api/v1/proposals router."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.routers.proposals import _generate_proposal_content
from app.schemas.proposal import GenerateProposalRequest
from tests.conftest import FAKE_USER_SUB, fake_job

API = "/api/v1/proposals"


def fake_proposal(overrides: dict | None = None) -> dict:
    base = {
        "id":          "proposal-001",
        "userId":      FAKE_USER_SUB,
        "title":       "Test Proposal",
        "clientName":  "Acme Corp",
        "status":      "draft",
        "content":     "",
        "description": "A proposal for AI services.",
        "createdAt":   "2024-01-01T00:00:00Z",
        "updatedAt":   "2024-01-01T00:00:00Z",
    }
    if overrides:
        base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_list_proposals_empty(client):
    with (
        patch("app.routers.proposals.proposals_repo.list",  new_callable=AsyncMock, return_value=[]),
        patch("app.routers.proposals.proposals_repo.count", new_callable=AsyncMock, return_value=0),
    ):
        resp = await client.get(API)
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_create_proposal(client):
    proposal = fake_proposal()
    with patch("app.routers.proposals.proposals_repo.create", new_callable=AsyncMock, return_value=proposal):
        resp = await client.post(API, json={
            "title":       "Test Proposal",
            "clientName":  "Acme Corp",
            "description": "A proposal for AI services.",
        })
    assert resp.status_code == 201
    assert resp.json()["id"] == "proposal-001"


@pytest.mark.asyncio
async def test_get_proposal_not_found(client):
    with patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.get(f"{API}/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_generate_proposal_by_id_enqueues_celery_task(client):
    proposal = fake_proposal()
    job = fake_job("proposal_generation")
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=job),
        patch("app.routers.proposals.task_generate_proposal.delay") as delay_mock,
    ):
        resp = await client.post(f"{API}/proposal-001/generate", json={
            "style": "professional",
            "language": "en",
        })
    assert resp.status_code == 202
    assert resp.json()["job_id"] == job["id"]
    assert resp.json()["proposal_id"] == "proposal-001"
    delay_mock.assert_called_once()


@pytest.mark.asyncio
async def test_generate_proposal_by_id_sync_opt_in(client):
    proposal = fake_proposal()
    job = fake_job("proposal_generation")
    updated = fake_proposal({"status": "generated"})
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=job),
        patch("app.routers.proposals.task_generate_proposal.delay") as delay_mock,
        patch("app.routers.proposals.generate_proposal_now", new_callable=AsyncMock, return_value=updated) as sync_mock,
    ):
        resp = await client.post(f"{API}/proposal-001/generate", json={
            "style": "professional",
            "language": "en",
            "sync": True,
        })
    assert resp.status_code == 200
    assert resp.json()["status"] == "generated"
    delay_mock.assert_not_called()
    sync_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_proposal_by_id_falls_back_when_celery_fails(client):
    proposal = fake_proposal()
    job = fake_job("proposal_generation")
    updated = fake_proposal({"status": "generated"})
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=job),
        patch("app.routers.proposals.task_generate_proposal.delay", side_effect=ConnectionError("Redis down")),
        patch("app.routers.proposals.generate_proposal_now", new_callable=AsyncMock, return_value=updated) as sync_mock,
    ):
        resp = await client.post(f"{API}/proposal-001/generate", json={
            "style": "professional",
            "language": "en",
        })
    assert resp.status_code == 200
    assert resp.json()["status"] == "generated"
    sync_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_proposal_by_id_fallback_failure_fails_job(client):
    proposal = fake_proposal()
    job = fake_job("proposal_generation")
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=job),
        patch("app.routers.proposals.task_generate_proposal.delay", side_effect=ConnectionError("Redis down")),
        patch("app.routers.proposals.generate_proposal_now", side_effect=RuntimeError("LLM failed")),
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock) as update_mock,
        patch("app.routers.proposals.jobs_repo.fail_job", new_callable=AsyncMock) as fail_mock,
    ):
        with pytest.raises(RuntimeError, match="LLM failed"):
            await client.post(f"{API}/proposal-001/generate", json={
                "style": "professional",
                "language": "en",
            })
    update_mock.assert_awaited_once_with("proposal-001", {"status": "error"})
    fail_mock.assert_awaited_once_with(job["id"], "LLM failed")


@pytest.mark.asyncio
async def test_generate_proposal_by_id(client):
    proposal = fake_proposal()
    generated = {
        "content": "<p>Generated</p>",
        "downloadUrl": "generated.md",
        "filePath": "generated.md",
    }
    updated = fake_proposal({"content": generated["content"], "status": "generated", "language": "en"})
    job = fake_job("proposal_generation")
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=job),
        patch("app.workers.tasks.proposal_tasks.jobs_repo.update_progress", new_callable=AsyncMock),
        patch("app.workers.tasks.proposal_tasks.jobs_repo.complete_job", new_callable=AsyncMock),
        patch("app.workers.tasks.proposal_tasks._generate_proposal_content", new_callable=AsyncMock, return_value=generated) as generate_content,
        patch("app.workers.tasks.proposal_tasks.proposals_repo.update", new_callable=AsyncMock, return_value=updated) as update_proposal,
    ):
        resp = await client.post(f"{API}/proposal-001/generate", json={
            "style": "professional", "language": "en", "customPrompt": "Emphasize commercial benefits.", "sync": True
        })
    assert resp.status_code == 200
    assert resp.json()["status"] == "generated"
    assert resp.json()["language"] == "en"
    assert update_proposal.await_args.args[1]["language"] == "en"
    assert update_proposal.await_args.args[1]["customPrompt"] == "Emphasize commercial benefits."
    assert generate_content.await_args.kwargs["custom_prompt"] == "Emphasize commercial benefits."


def test_generate_request_accepts_frontend_line_item_shape():
    request = GenerateProposalRequest.model_validate({
        "lineItems": [{
            "service": "AI Workflow Implementation",
            "description": "Configure the workflow.",
            "quantity": 2,
            "unitPrice": 3800,
        }],
        "totalAmount": 7600,
        "length": "extended",
    })

    assert request.lineItems is not None
    assert request.lineItems[0].name == "AI Workflow Implementation"
    assert request.lineItems[0].qty == 2
    assert request.lineItems[0].unitPrice == 3800
    assert request.totalAmount == 7600
    assert request.length == "extended"


@pytest.mark.asyncio
async def test_generate_draft_enqueues_celery_task(client):
    proposal = fake_proposal()
    job = fake_job("proposal_generation")
    with (
        patch("app.routers.proposals.proposals_repo.create", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=job),
        patch("app.routers.proposals.task_generate_proposal.delay") as delay_mock,
    ):
        resp = await client.post(f"{API}/generate-draft", json={
            "title": "Automation Proposal",
            "clientName": "Acme Corp",
            "description": "Automate finance operations.",
        })
    assert resp.status_code == 202
    assert resp.json()["job_id"] == job["id"]
    assert resp.json()["proposal_id"] == proposal["id"]
    delay_mock.assert_called_once()


@pytest.mark.asyncio
async def test_generate_draft_falls_back_when_celery_fails(client):
    proposal = fake_proposal()
    job = fake_job("proposal_generation")
    updated = fake_proposal({"status": "generated"})
    with (
        patch("app.routers.proposals.proposals_repo.create", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=job),
        patch("app.routers.proposals.task_generate_proposal.delay", side_effect=ConnectionError("Redis down")),
        patch("app.routers.proposals.generate_proposal_now", new_callable=AsyncMock, return_value=updated) as sync_mock,
    ):
        resp = await client.post(f"{API}/generate-draft", json={
            "title": "Automation Proposal",
            "clientName": "Acme Corp",
            "description": "Automate finance operations.",
        })
    assert resp.status_code == 201
    assert resp.json()["status"] == "generated"
    sync_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_draft_passes_frontend_payload_to_generator(client):
    generated = {
        "content": "<p>Generated</p>",
        "downloadUrl": "generated.md",
        "filePath": "generated.md",
    }
    saved = fake_proposal({"content": generated["content"], "status": "generated", "language": "en"})
    job = fake_job("proposal_generation")
    with (
        patch(
            "app.workers.tasks.proposal_tasks._generate_proposal_content",
            new_callable=AsyncMock,
            return_value=generated,
        ) as generate_content,
        patch("app.routers.proposals.proposals_repo.create", new_callable=AsyncMock, return_value=saved) as create_proposal,
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=job),
        patch("app.workers.tasks.proposal_tasks.jobs_repo.update_progress", new_callable=AsyncMock),
        patch("app.workers.tasks.proposal_tasks.jobs_repo.complete_job", new_callable=AsyncMock),
        patch("app.workers.tasks.proposal_tasks.proposals_repo.update", new_callable=AsyncMock, return_value=saved),
    ):
        resp = await client.post(f"{API}/generate-draft", json={
            "title": "Automation Proposal",
            "clientName": "Acme Corp",
            "description": "Automate finance operations.",
            "detailedDescription": "Process invoices and reconcile exceptions.",
            "teamSizing": "2 analysts and 1 team lead",
            "lineItems": [{
                "service": "Invoice Processing",
                "description": "Monthly managed service",
                "quantity": 2,
                "unitPrice": 1750,
            }],
            "totalAmount": 3500,
            "length": "extended",
            "language": "en",
            "customPrompt": "Emphasize outcomes over problems.",
            "sync": True,
        })

    assert resp.status_code == 201
    assert resp.json()["language"] == "en"
    assert create_proposal.await_args.args[0]["language"] == "en"
    assert create_proposal.await_args.args[0]["customPrompt"] == "Emphasize outcomes over problems."
    assert generate_content.await_args.kwargs == {
        "detailed_description": "Process invoices and reconcile exceptions.",
        "team_sizing": "2 analysts and 1 team lead",
        "line_items": [{
            "name": "Invoice Processing",
            "description": "Monthly managed service",
            "qty": 2.0,
            "unitPrice": 1750.0,
        }],
        "total_amount": 3500.0,
        "length": "extended",
        "language": "en",
        "custom_prompt": "Emphasize outcomes over problems.",
    }


@pytest.mark.asyncio
async def test_generation_prompt_uses_real_line_items_and_removes_example_prices(tmp_path):
    with (
        patch("app.routers.proposals._output_dir", return_value=tmp_path),
        patch(
            "app.routers.proposals.deepseek_service.generate_text",
            new_callable=AsyncMock,
            return_value="<p>Generated</p>",
        ) as generate_text,
    ):
        await _generate_proposal_content(
            "Automation Proposal",
            "Acme Corp",
            "Automate finance operations.",
            detailed_description="Process invoices and reconcile exceptions.",
            team_sizing="2 analysts and 1 team lead",
            line_items=[{
                "name": "Invoice Processing",
                "description": "Monthly managed service",
                "qty": 2,
                "unitPrice": 1750,
            }],
            total_amount=3500,
            length="extended",
            language="English",
            custom_prompt="Frame this as a commercial offer.",
        )

    prompt = generate_text.await_args.args[0]
    assert "Invoice Processing" in prompt
    assert "Monthly managed service" in prompt
    assert "Quantity: 2" in prompt
    assert "Unit price: 1750" in prompt
    assert "Provided total: 3500" in prompt
    assert "Process invoices and reconcile exceptions." in prompt
    assert "2 analysts and 1 team lead" in prompt
    assert "approximately 1100-1400 words" in prompt
    assert "5-6 pages maximum" in prompt
    assert "Never exceed 6 rendered pages" in prompt
    assert "Anti-filler requirement:" in prompt
    assert "Never increase length through repetition" in prompt
    assert "CONTENT QUALITY INSTRUCTIONS:" in prompt
    assert "Problems Identified: exactly 4-5 problems" in prompt
    assert "Technologies Used: exactly 4-6 technologies" in prompt
    assert "Expected ROI: include at least 3 projected metrics" in prompt
    assert "Next Steps: include 4-5 sequenced steps with estimated weeks." in prompt
    assert "Format Problems Identified and Technologies Used list items" in prompt
    assert "following language: English" in prompt
    assert "Respond ONLY with a clean semantic HTML fragment." in prompt
    assert "Do not include <html>, <body>, <article>, or any outer <div> container." in prompt
    assert "Do not use inline styles, style attributes, CSS classes" in prompt
    assert "<h2>Executive Summary</h2>" in prompt
    assert "<h2>Problems Identified</h2>" in prompt
    assert "<h2>Proposed AI Solution</h2>" in prompt
    assert "<h2>Technologies Used</h2>" in prompt
    assert "<h2>Implementation Costs</h2>" in prompt
    assert "<h2>Expected ROI</h2>" in prompt
    assert "<h2>Next Steps</h2>" in prompt
    assert '<div style="padding:40px' not in prompt
    assert "style=" not in prompt
    assert "Keep these exact English section headings as structural markers; write ALL" in prompt
    assert "body text, descriptions, labels, and table content in English." in prompt
    assert "PRIORITY STYLE AND FOCUS INSTRUCTION:" in prompt
    assert "Frame this as a commercial offer." in prompt
    assert "Desarrollo App" not in prompt
    assert "$2,500 USD" not in prompt
    assert "Integración IA" not in prompt
    assert "$5,500 USD" not in prompt


@pytest.mark.asyncio
async def test_generation_prompt_without_items_requires_to_be_defined(tmp_path):
    with (
        patch("app.routers.proposals._output_dir", return_value=tmp_path),
        patch(
            "app.routers.proposals.deepseek_service.generate_text",
            new_callable=AsyncMock,
            return_value="<p>Generated</p>",
        ) as generate_text,
    ):
        await _generate_proposal_content(
            "Discovery Proposal",
            "Acme Corp",
            "Discovery engagement.",
            length="brief",
            language="es",
        )

    prompt = generate_text.await_args.args[0]
    assert '"A definir"' in prompt
    assert "Do not invent services or prices." in prompt
    assert "approximately 400-600 words" in prompt
    assert "about 1 page" in prompt
    assert "Anti-filler requirement:" in prompt
    assert "Desarrollo App" not in prompt
    assert "$2,500 USD" not in prompt


@pytest.mark.asyncio
async def test_delete_proposal_success(client):
    proposal = fake_proposal()
    with (
        patch("app.routers.proposals.proposals_repo.get",    new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.proposals_repo.delete", new_callable=AsyncMock, return_value=None),
    ):
        resp = await client.delete(f"{API}/proposal-001")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_delete_proposal_forbidden(client):
    other = fake_proposal({"userId": "other-user"})
    with patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=other):
        resp = await client.delete(f"{API}/proposal-001")
    assert resp.status_code == 403
