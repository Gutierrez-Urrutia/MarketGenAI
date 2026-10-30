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
        "user_id": FAKE_USER_SUB,
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
    assert "approximately 1500-2000 words" in prompt
    assert "5-6 pages maximum" in prompt
    assert "Never exceed 6 rendered pages" in prompt
    assert "Anti-filler requirement:" in prompt
    assert "Never increase length through repetition" in prompt
    assert "CONTENT QUALITY INSTRUCTIONS:" in prompt
    assert "business process outsourcing (BPO)" in prompt
    assert "Never write prices or amounts yourself" in prompt
    assert "[[PRICING_TABLE]]" in prompt
    assert "following language: English" in prompt
    assert "Respond ONLY with a clean semantic HTML fragment." in prompt
    assert "Do not include <html>, <body>, <article>, or any outer <div> container." in prompt
    assert "Do not use inline styles, style attributes, CSS classes" in prompt
    for heading in (
        "Executive Summary", "About NoonDalton", "Understanding of the Need", "Scope and Objectives",
        "Operating Model and Service Levels", "Team and Work Organization",
        "Implementation Plan", "Pricing and Commercial Terms", "General Terms",
    ):
        assert f"<h2>{heading}</h2>" in prompt
    assert "NEVER mention internal CRM or sales-pipeline data" in prompt
    assert "prices exclude applicable taxes" in prompt
    assert "Team and pricing must be consistent" in prompt
    assert "Proposed AI Solution" not in prompt
    assert "Technologies Used" not in prompt
    assert '<div style="padding:40px' not in prompt
    assert "style=" not in prompt
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
    assert "approximately 500-700 words" in prompt
    assert "about 1-2 pages" in prompt
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


@pytest.mark.asyncio
async def test_generated_content_gets_deterministic_pricing_table(tmp_path):
    """El LLM solo pone el marcador; las cifras vienen de lineItems, nunca del modelo."""
    llm_html = "<h1>T</h1><h2>Precios y Condiciones Comerciales</h2><p>[[PRICING_TABLE]]</p><h2>Condiciones Generales</h2><ul><li>x</li></ul>"
    with (
        patch("app.routers.proposals._output_dir", return_value=tmp_path),
        patch("app.routers.proposals.deepseek_service.generate_text", new_callable=AsyncMock, return_value="```html\n" + llm_html + "\n```"),
    ):
        result = await _generate_proposal_content(
            "Propuesta", "Acme", "Cobranza", language="es",
            line_items=[{"name": "Gestores", "description": "Mensual", "qty": 15, "unitPrice": 1250}],
            total_amount=18750,
        )
    html = result["content"]
    assert "[[PRICING_TABLE]]" not in html and "```" not in html
    assert 'class="pricing-table"' in html
    assert "$1.250 USD" in html and "$18.750 USD" in html  # es: separador de miles con punto
    assert "Precio unitario" in html


def test_inject_pricing_table_fallback_when_marker_missing():
    from app.workers.tasks.proposal_tasks import build_pricing_table_html, inject_pricing_table
    table = build_pricing_table_html(None, None, "en")
    out = inject_pricing_table("<h2>A</h2><p>x</p><h2>B</h2><p>y</p>", table)
    assert out.index("pricing-table") < out.index("<h2>B</h2>")
    assert "To be defined" in table


@pytest.mark.asyncio
async def test_generation_returns_sources_and_prompt_requires_exclusions_and_termination(tmp_path):
    sources = [{"docId": "d1", "title": "Propuesta Cobranza", "text": "Cobranza con discador predictivo."}]
    with (
        patch("app.routers.proposals._output_dir", return_value=tmp_path),
        patch("app.services.rag_proposal_service.retrieve_sources", new_callable=AsyncMock, return_value=sources),
        patch("app.routers.proposals.deepseek_service.generate_text", new_callable=AsyncMock, return_value="<p>x</p>") as generate_text,
    ):
        result = await _generate_proposal_content(
            "Cobranza", "Acme", "Cobranza telefónica", language="es", user_id="u1",
        )

    assert result["sources"] == [{"docId": "d1", "title": "Propuesta Cobranza"}]
    prompt = generate_text.await_args.args[0]
    assert "Exclusions: what the service does not include" in prompt
    assert "subject to agreement and legal review" in prompt
