"""Tests for the /api/v1/templates router."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.routers import templates as templates_router
from tests.conftest import FAKE_USER_SUB, fake_job

API = "/api/v1/templates"


def fake_template(overrides: dict | None = None) -> dict:
    base = {
        "id":          "tmpl-001",
        "userId":      FAKE_USER_SUB,
        "name":        "Proposal Template",
        "type":        "proposal",
        "description": "Standard B2B proposal template.",
        "content":     "Hello {client_name}, please find our proposal for {product}.",
        "variables":   ["client_name", "product"],
        "isPublic":    False,
        "usageCount":  0,
        "createdAt":   "2024-01-01T00:00:00Z",
        "updatedAt":   "2024-01-01T00:00:00Z",
    }
    if overrides:
        base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_list_templates(client):
    templates = [fake_template()]
    with (
        patch("app.routers.templates.templates_repo.list",  new_callable=AsyncMock, return_value=templates),
        patch("app.routers.templates.templates_repo.count", new_callable=AsyncMock, return_value=1),
    ):
        resp = await client.get(API)
    assert resp.status_code == 200
    assert resp.json()["total"] == 1


@pytest.mark.asyncio
async def test_create_template(client):
    tmpl = fake_template()
    with patch("app.routers.templates.templates_repo.create", new_callable=AsyncMock, return_value=tmpl):
        resp = await client.post(API, json={
            "name":    "Proposal Template",
            "type":    "proposal",
            "content": "Hello {client_name}.",
        })
    assert resp.status_code == 201
    assert resp.json()["id"] == "tmpl-001"


@pytest.mark.asyncio
async def test_extract_template_text_file(client):
    resp = await client.post(
        f"{API}/extract",
        files={"file": ("proposal-template.txt", b"Hello {{customer_name}}", "text/plain")},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "name": "proposal-template",
        "content": "Hello {{customer_name}}",
    }


@pytest.mark.asyncio
async def test_extract_template_pdf_file(client, monkeypatch):
    class FakePage:
        def __init__(self, text: str):
            self._text = text

        def extract_text(self):
            return self._text

    class FakePdfReader:
        def __init__(self, _stream):
            self.pages = [FakePage("Page one"), FakePage("Page two")]

    monkeypatch.setattr(templates_router, "PdfReader", FakePdfReader)

    resp = await client.post(
        f"{API}/extract",
        files={"file": ("proposal-template.pdf", b"%PDF fake", "application/pdf")},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "name": "proposal-template",
        "content": "Page one\n\nPage two",
    }


@pytest.mark.asyncio
async def test_get_template_not_found(client):
    with patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=None):
        resp = await client.get(f"{API}/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_template(client):
    existing = fake_template()
    updated = fake_template({"name": "Updated Proposal Template", "content": "Updated content"})
    with (
        patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=existing),
        patch("app.routers.templates.templates_repo.update", new_callable=AsyncMock, return_value=updated) as update_mock,
    ):
        resp = await client.put(f"{API}/tmpl-001", json={
            "name": "Updated Proposal Template",
            "content": "Updated content",
        })
    assert resp.status_code == 200
    assert resp.json()["name"] == "Updated Proposal Template"
    update_mock.assert_awaited_once_with("tmpl-001", {
        "name": "Updated Proposal Template",
        "content": "Updated content",
    })


@pytest.mark.asyncio
async def test_update_template_forbidden(client):
    other = fake_template({"userId": "other-user"})
    with patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=other):
        resp = await client.put(f"{API}/tmpl-001", json={"name": "Nope"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_apply_template_substitutes_variables(client):
    """POST /{id}/apply should return content with variables replaced."""
    tmpl = fake_template()
    with (
        patch("app.routers.templates.templates_repo.get",    new_callable=AsyncMock, return_value=tmpl),
        patch("app.routers.templates.templates_repo.update", new_callable=AsyncMock, return_value=tmpl),
    ):
        resp = await client.post(f"{API}/tmpl-001/apply", json={
            "variables": {"client_name": "NoonDalton", "product": "AI Suite"},
        })
    assert resp.status_code == 200
    rendered = resp.json()["rendered"]
    assert "NoonDalton" in rendered
    assert "AI Suite" in rendered
    assert "{client_name}" not in rendered


# ── RF-VTA-07: clasificación, condiciones comerciales y variables automáticas ──

def fake_proposal(overrides: dict | None = None) -> dict:
    base = {
        "id":            "prop-abcd1234",
        "userId":        FAKE_USER_SUB,
        "title":         "Back office para Acme",
        "clientName":    "Ana Pérez",
        "clientEmail":   "ana@acme.com",
        "clientCompany": "Acme (copia en la propuesta)",
        "totalAmount":   21950,
        "language":      "es",
        "issuedBy":      "Pablo",
        "createdAt":     "2026-10-01T12:00:00Z",
    }
    if overrides:
        base.update(overrides)
    return base


def fake_customer(overrides: dict | None = None) -> dict:
    base = {
        "id":      "cust-001",
        "userId":  FAKE_USER_SUB,
        "name":    "Ana Pérez",
        "email":   "ana@acme.com",
        "company": "Acme S.A.",
    }
    if overrides:
        base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_catalog_lists_classification_and_variables(client):
    resp = await client.get(f"{API}/catalog")
    assert resp.status_code == 200
    data = resp.json()
    assert "back_office" in {s["value"] for s in data["serviceTypes"]}
    assert "healthcare" in {i["value"] for i in data["industries"]}
    assert "cliente_empresa" in data["standardVariables"]["customer"]
    assert set(data["defaultCommercialTerms"]) == {"es", "en", "pt"}


@pytest.mark.asyncio
async def test_create_proposal_template_gets_default_commercial_terms(client):
    async def echo(data):
        return {"id": "tmpl-new", **data}

    with patch("app.routers.templates.templates_repo.create", new_callable=AsyncMock, side_effect=echo) as create_mock:
        resp = await client.post(API, json={
            "name": "BPO salud", "type": "proposal", "content": "Hola {cliente_nombre}",
            "serviceType": "back_office", "industry": "healthcare",
        })
    assert resp.status_code == 201
    saved = create_mock.await_args.args[0]
    assert saved["serviceType"] == "back_office"
    assert saved["industry"] == "healthcare"
    assert "Forma de pago" in saved["commercialTerms"]
    assert resp.json()["commercialTerms"] == saved["commercialTerms"]


@pytest.mark.asyncio
async def test_create_template_rejects_unknown_service_type(client):
    resp = await client.post(API, json={
        "name": "X template", "type": "proposal", "content": "x", "serviceType": "astrology",
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_update_proposal_template_rejects_blank_commercial_terms(client):
    with patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=fake_template()):
        resp = await client.put(f"{API}/tmpl-001", json={"commercialTerms": "   "})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_get_legacy_template_fills_classification_and_terms(client):
    """Plantillas guardadas antes de RF-VTA-07 no tienen los campos nuevos."""
    with patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=fake_template()):
        resp = await client.get(f"{API}/tmpl-001")
    assert resp.status_code == 200
    data = resp.json()
    assert data["serviceType"] == "other"
    assert data["industry"] == "general"
    assert data["commercialTerms"]


@pytest.mark.asyncio
async def test_list_filters_by_service_type_and_industry(client):
    templates = [
        fake_template({"id": "t-legacy"}),  # sin clasificación → other / general
        fake_template({"id": "t-bo-health", "serviceType": "back_office", "industry": "healthcare"}),
        fake_template({"id": "t-bo-retail", "serviceType": "back_office", "industry": "retail_ecommerce"}),
    ]
    with patch("app.routers.templates.templates_repo.list", new_callable=AsyncMock, return_value=templates):
        by_service = await client.get(API, params={"serviceType": "back_office", "include_public": False})
        by_both = await client.get(API, params={"serviceType": "back_office", "industry": "healthcare", "include_public": False})
        legacy = await client.get(API, params={"industry": "general", "include_public": False})
    assert [t["id"] for t in by_service.json()["items"]] == ["t-bo-health", "t-bo-retail"]
    assert by_service.json()["total"] == 2
    assert [t["id"] for t in by_both.json()["items"]] == ["t-bo-health"]
    assert [t["id"] for t in legacy.json()["items"]] == ["t-legacy"]


@pytest.mark.asyncio
async def test_list_rejects_unknown_industry(client):
    resp = await client.get(API, params={"industry": "astrology"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_apply_fills_variables_from_proposal_and_customer(client):
    tmpl = fake_template({
        "content": "Propuesta {propuesta_titulo} para {{cliente_empresa}} ({cliente_email}) — {servicio}, {industria}. Ref {referencia}.",
        "commercialTerms": "Total {monto_total}, válida hasta {valida_hasta}. Contacto: {cliente_nombre}.",
        "serviceType": "back_office",
        "industry": "healthcare",
    })
    with (
        patch("app.routers.templates.templates_repo.get",    new_callable=AsyncMock, return_value=tmpl),
        patch("app.routers.templates.templates_repo.update", new_callable=AsyncMock, return_value=tmpl),
        patch("app.routers.proposals.proposals_repo.get_or_404", new_callable=AsyncMock, return_value=fake_proposal()),
        patch("app.routers.customers.customers_repo.get", new_callable=AsyncMock, return_value=fake_customer()),
    ):
        resp = await client.post(f"{API}/tmpl-001/apply", json={
            "proposalId": "prop-abcd1234", "customerId": "cust-001",
        })
    assert resp.status_code == 200
    data = resp.json()
    assert data["rendered"] == (
        "Propuesta Back office para Acme para Acme S.A. (ana@acme.com) — Back office, Salud. "
        "Ref NDP-20261001-PROP."
    )
    assert data["commercialTerms"] == "Total $21.950 USD, válida hasta 31 de octubre de 2026. Contacto: Ana Pérez."
    assert data["missingVariables"] == []


@pytest.mark.asyncio
async def test_apply_manual_values_override_and_missing_are_reported(client):
    tmpl = fake_template({
        "content": "Hola {cliente_nombre}, plazo {plazo_meses} meses.",
        "commercialTerms": "Total {monto_total}.",
    })
    with (
        patch("app.routers.templates.templates_repo.get",    new_callable=AsyncMock, return_value=tmpl),
        patch("app.routers.templates.templates_repo.update", new_callable=AsyncMock, return_value=tmpl),
        patch(
            "app.routers.proposals.proposals_repo.get_or_404", new_callable=AsyncMock,
            return_value=fake_proposal({"totalAmount": None}),
        ),
    ):
        resp = await client.post(f"{API}/tmpl-001/apply", json={
            "proposalId": "prop-abcd1234", "variables": {"cliente_nombre": "Sr. Pérez"},
        })
    data = resp.json()
    assert data["rendered"] == "Hola Sr. Pérez, plazo {plazo_meses} meses."
    assert data["commercialTerms"] == "Total {monto_total}."
    assert data["missingVariables"] == ["plazo_meses", "monto_total"]


@pytest.mark.asyncio
async def test_apply_with_foreign_proposal_is_forbidden(client):
    with (
        patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=fake_template()),
        patch(
            "app.routers.proposals.proposals_repo.get_or_404", new_callable=AsyncMock,
            return_value=fake_proposal({"userId": "other-user"}),
        ),
    ):
        resp = await client.post(f"{API}/tmpl-001/apply", json={"proposalId": "prop-abcd1234"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_apply_with_foreign_customer_is_forbidden(client):
    with (
        patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=fake_template()),
        patch(
            "app.routers.customers.customers_repo.get", new_callable=AsyncMock,
            return_value=fake_customer({"userId": "other-user"}),
        ),
    ):
        resp = await client.post(f"{API}/tmpl-001/apply", json={"customerId": "cust-001"})
    assert resp.status_code == 403


# ── RF-VTA-07: plantilla aplicada al generar una propuesta ────────────────────

@pytest.mark.asyncio
async def test_generate_proposal_with_template_passes_rendered_template_to_worker(client):
    proposal = fake_proposal({"serviceType": "collections"})
    tmpl = fake_template({
        "content": "Propuesta para {cliente_empresa}, plazo {plazo_meses} meses.",
        "commercialTerms": "Total {monto_total}.\nPago a 30 días.",
        "serviceType": "back_office",
        "industry": "healthcare",
    })
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=proposal) as proposal_update,
        patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=tmpl),
        patch("app.routers.templates.templates_repo.update", new_callable=AsyncMock, return_value=tmpl),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=fake_job("proposal_generation")),
        patch("app.routers.proposals.task_generate_proposal.delay") as delay_mock,
    ):
        resp = await client.post("/api/v1/proposals/prop-abcd1234/generate", json={
            "language": "es",
            "templateId": "tmpl-001",
            "templateVariables": {"plazo_meses": 12},
            "templateContent": "texto inyectado por el cliente",
        })
    assert resp.status_code == 202
    options = delay_mock.call_args.args[5]
    assert options["templateContent"] == "Propuesta para Acme (copia en la propuesta), plazo 12 meses."
    assert options["commercialTerms"] == "Total $21.950 USD.\nPago a 30 días."
    proposal_update.assert_awaited_once_with("prop-abcd1234", {
        "templateId": "tmpl-001", "templateVariables": {"plazo_meses": 12},
        "serviceType": "collections", "industry": "healthcare",
    })


@pytest.mark.asyncio
async def test_regenerate_without_template_clears_previous_template(client):
    proposal = fake_proposal({"templateId": "tmpl-old", "templateVariables": {"x": "1"}})
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock, return_value=proposal) as proposal_update,
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=fake_job("proposal_generation")),
        patch("app.routers.proposals.task_generate_proposal.delay"),
    ):
        resp = await client.post("/api/v1/proposals/prop-abcd1234/generate", json={})
    assert resp.status_code == 202
    proposal_update.assert_awaited_once_with("prop-abcd1234", {"templateId": None, "templateVariables": None})


@pytest.mark.asyncio
async def test_generate_proposal_without_template_drops_client_template_text(client):
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=fake_job("proposal_generation")),
        patch("app.routers.proposals.task_generate_proposal.delay") as delay_mock,
    ):
        resp = await client.post("/api/v1/proposals/prop-abcd1234/generate", json={
            "templateContent": "x", "commercialTerms": "y",
        })
    assert resp.status_code == 202
    options = delay_mock.call_args.args[5]
    assert "templateContent" not in options and "commercialTerms" not in options


@pytest.mark.asyncio
async def test_generate_proposal_with_foreign_template_is_forbidden(client):
    with (
        patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=fake_template({"userId": "other-user"})),
        patch("app.routers.proposals.task_generate_proposal.delay") as delay_mock,
    ):
        resp = await client.post("/api/v1/proposals/prop-abcd1234/generate", json={"templateId": "tmpl-001"})
    assert resp.status_code == 403
    delay_mock.assert_not_called()


@pytest.mark.asyncio
async def test_generated_content_uses_template_and_its_commercial_terms(tmp_path):
    from app.routers.proposals import _generate_proposal_content

    llm_html = (
        "<h1>T</h1><h2>Precios y Condiciones Comerciales</h2><p>[[PRICING_TABLE]]</p>"
        "<p>[[COMMERCIAL_TERMS]]</p><h2>Condiciones Generales</h2><ul><li>x</li></ul>"
    )
    with (
        patch("app.routers.proposals._output_dir", return_value=tmp_path),
        patch("app.routers.proposals.deepseek_service.generate_text", new_callable=AsyncMock, return_value=llm_html) as generate_text,
    ):
        result = await _generate_proposal_content(
            "Propuesta", "Acme", "Cobranza", language="es",
            template_content="Enfocar en recupero temprano para Acme.",
            commercial_terms="- Pago a 30 días <neto>\n\n• Vigencia 60 días",
        )
    html = result["content"]
    assert "[[COMMERCIAL_TERMS]]" not in html and "[[PRICING_TABLE]]" not in html
    assert "<ul><li>Pago a 30 días &lt;neto&gt;</li><li>Vigencia 60 días</li></ul>" in html
    assert html.index("pricing-table") < html.index("Pago a 30 días") < html.index("Condiciones Generales")
    prompt = generate_text.await_args.args[0]
    assert "Enfocar en recupero temprano para Acme." in prompt
    assert "do not write commercial terms yourself" in prompt
    assert "state the currency (USD)" not in prompt


def test_commercial_terms_fallback_goes_after_pricing_table():
    from app.workers.tasks.proposal_tasks import build_pricing_table_html, inject_commercial_terms, inject_pricing_table

    content = inject_pricing_table("<h2>A</h2><p>x</p><h2>B</h2><p>y</p>", build_pricing_table_html(None, None, "es"))
    out = inject_commercial_terms(content, "Pago a 30 días")
    assert out.index("pricing-table") < out.index("Pago a 30 días") < out.index("<h2>B</h2>")
    assert inject_commercial_terms(content, "  \n ") == content


def test_cover_shows_service_and_industry_from_proposal():
    from app.routers.proposals import _proposal_cover_fields

    cover = _proposal_cover_fields(fake_proposal({"serviceType": "back_office", "industry": "healthcare"}))
    assert (cover["service_line"], cover["industry"]) == ("Back office", "Salud")
    legacy = _proposal_cover_fields(fake_proposal({"serviceType": "B2B Operations"}))
    assert (legacy["service_line"], legacy["industry"]) == ("", "")


@pytest.mark.asyncio
async def test_delete_template(client):
    tmpl = fake_template()
    with (
        patch("app.routers.templates.templates_repo.get",    new_callable=AsyncMock, return_value=tmpl),
        patch("app.routers.templates.templates_repo.delete", new_callable=AsyncMock, return_value=None),
    ):
        resp = await client.delete(f"{API}/tmpl-001")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_delete_template_forbidden(client):
    other = fake_template({"userId": "other-user"})
    with patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=other):
        resp = await client.delete(f"{API}/tmpl-001")
    assert resp.status_code == 403


# ── RF-VTA-07 (cierre): límite de texto, límite de uso, plantillas públicas ────

@pytest.mark.asyncio
async def test_create_template_rejects_text_over_limit(client):
    """CP-131: el contenido y las condiciones comerciales tienen un máximo de 50 000 caracteres."""
    too_long = "x" * 50_001
    resp = await client.post(API, json={"name": "Larga", "type": "proposal", "content": too_long})
    assert resp.status_code == 422
    resp = await client.post(API, json={"name": "Larga", "type": "proposal", "content": "ok", "commercialTerms": too_long})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_template_accepts_text_at_limit(client):
    async def echo(data):
        return {"id": "tmpl-max", **data}

    with patch("app.routers.templates.templates_repo.create", new_callable=AsyncMock, side_effect=echo):
        resp = await client.post(API, json={"name": "Justa", "type": "proposal", "content": "x" * 50_000})
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_update_template_rejects_text_over_limit(client):
    existing = fake_template()
    with patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=existing):
        resp = await client.put(f"{API}/tmpl-001", json={"content": "x" * 50_001})
        assert resp.status_code == 422
        resp = await client.put(f"{API}/tmpl-001", json={"commercialTerms": "x" * 50_001})
        assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_template_is_rate_limited(client):
    """Las rutas que escriben o procesan archivos aceptan 20 solicitudes por minuto; la 21 recibe 429."""
    async def echo(data):
        return {"id": "tmpl-x", **data}

    with patch("app.routers.templates.templates_repo.create", new_callable=AsyncMock, side_effect=echo):
        statuses = [
            (await client.post(API, json={"name": "Plantilla", "type": "proposal", "content": "Hola"})).status_code
            for _ in range(21)
        ]
    assert statuses[:20] == [201] * 20
    assert statuses[20] == 429


@pytest.mark.asyncio
async def test_apply_delete_and_extract_are_rate_limited(client):
    from app.core.rate_limit import limiter

    tmpl = fake_template()
    with (
        patch("app.routers.templates.templates_repo.get",    new_callable=AsyncMock, return_value=tmpl),
        patch("app.routers.templates.templates_repo.update", new_callable=AsyncMock, return_value=tmpl),
        patch("app.routers.templates.templates_repo.delete", new_callable=AsyncMock),
    ):
        apply_codes = [(await client.post(f"{API}/tmpl-001/apply", json={})).status_code for _ in range(21)]
        assert apply_codes[:20] == [200] * 20 and apply_codes[20] == 429
        limiter.reset()
        update_codes = [(await client.put(f"{API}/tmpl-001", json={"name": "Otro nombre"})).status_code for _ in range(21)]
        assert update_codes[:20] == [200] * 20 and update_codes[20] == 429
        limiter.reset()
        delete_codes = [(await client.delete(f"{API}/tmpl-001")).status_code for _ in range(21)]
        assert delete_codes[:20] == [204] * 20 and delete_codes[20] == 429
        limiter.reset()
        extract_codes = [
            (await client.post(f"{API}/extract", files={"file": ("a.txt", b"Hola {x}", "text/plain")})).status_code
            for _ in range(21)
        ]
    assert extract_codes[:20] == [200] * 20 and extract_codes[20] == 429


@pytest.mark.asyncio
async def test_public_template_of_other_user_can_be_read_and_applied(client):
    public = fake_template({"userId": "other-user", "isPublic": True})
    with (
        patch("app.routers.templates.templates_repo.get",    new_callable=AsyncMock, return_value=public),
        patch("app.routers.templates.templates_repo.update", new_callable=AsyncMock, return_value=public),
    ):
        got = await client.get(f"{API}/tmpl-001")
        applied = await client.post(f"{API}/tmpl-001/apply", json={"variables": {"client_name": "Acme", "product": "BPO"}})
    assert got.status_code == 200
    assert applied.status_code == 200
    assert "Acme" in applied.json()["rendered"]


@pytest.mark.asyncio
async def test_private_template_of_other_user_is_forbidden_to_read_and_apply(client):
    private = fake_template({"userId": "other-user", "isPublic": False})
    with patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=private):
        assert (await client.get(f"{API}/tmpl-001")).status_code == 403
        assert (await client.post(f"{API}/tmpl-001/apply", json={})).status_code == 403


@pytest.mark.asyncio
async def test_public_template_of_other_user_cannot_be_edited_or_deleted(client):
    public = fake_template({"userId": "other-user", "isPublic": True})
    with patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=public):
        assert (await client.put(f"{API}/tmpl-001", json={"name": "Mía ahora"})).status_code == 403
        assert (await client.delete(f"{API}/tmpl-001")).status_code == 403


@pytest.mark.asyncio
async def test_update_and_delete_unknown_template_return_404(client):
    with patch("app.routers.templates.templates_repo.get", new_callable=AsyncMock, return_value=None):
        assert (await client.delete(f"{API}/nonexistent")).status_code == 404
        assert (await client.put(f"{API}/nonexistent", json={"name": "Nada"})).status_code == 404


@pytest.mark.asyncio
async def test_apply_increments_usage_count(client):
    tmpl = fake_template({"usageCount": 5})
    with (
        patch("app.routers.templates.templates_repo.get",    new_callable=AsyncMock, return_value=tmpl),
        patch("app.routers.templates.templates_repo.update", new_callable=AsyncMock, return_value=tmpl) as update_mock,
    ):
        resp = await client.post(f"{API}/tmpl-001/apply", json={"variables": {"client_name": "A", "product": "B"}})
    assert resp.status_code == 200
    update_mock.assert_awaited_once_with("tmpl-001", {"usageCount": 6})


@pytest.mark.asyncio
async def test_list_search_matches_name_or_description(client):
    templates = [
        fake_template({"id": "t1", "name": "Cobranza bancaria", "description": "Mora temprana"}),
        fake_template({"id": "t2", "name": "Nómina", "description": "Liquidación mensual con cobranza"}),
        fake_template({"id": "t3", "name": "Soporte", "description": "Mesa de ayuda"}),
    ]
    with patch("app.routers.templates.templates_repo.list", new_callable=AsyncMock, return_value=templates):
        resp = await client.get(API, params={"search": "COBRANZA", "include_public": "false"})
    assert resp.status_code == 200
    assert {t["id"] for t in resp.json()["items"]} == {"t1", "t2"}
    assert resp.json()["total"] == 2


@pytest.mark.asyncio
async def test_list_include_public_false_skips_public_templates(client):
    own = fake_template({"id": "mine"})
    public = fake_template({"id": "theirs", "userId": "other-user", "isPublic": True})

    async def fake_list(filters=None, **_):
        return [public] if ("isPublic", "==", True) in (filters or []) else [own]

    with patch("app.routers.templates.templates_repo.list", new_callable=AsyncMock, side_effect=fake_list):
        with_public = await client.get(API)
        without_public = await client.get(API, params={"include_public": "false"})
    assert {t["id"] for t in with_public.json()["items"]} == {"mine", "theirs"}
    assert {t["id"] for t in without_public.json()["items"]} == {"mine"}
    # El total solo cuenta las plantillas propias que cumplen los filtros.
    assert with_public.json()["total"] == 1


DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _docx_bytes(paragraphs: list[str], table_rows: list[list[str]] | None = None) -> bytes:
    from io import BytesIO
    from docx import Document

    document = Document()
    for text in paragraphs:
        document.add_paragraph(text)
    if table_rows:
        table = document.add_table(rows=len(table_rows), cols=len(table_rows[0]))
        for r, row in enumerate(table_rows):
            for c, value in enumerate(row):
                table.cell(r, c).text = value
    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_extract_template_docx_keeps_variables_and_table_text(client):
    data = _docx_bytes(["Estimado {nombre}"], [["Servicio", "Monto"], ["Back office", "{monto}"]])
    resp = await client.post(f"{API}/extract", files={"file": ("plantilla.docx", data, DOCX_MIME)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "plantilla"
    assert "{nombre}" in body["content"] and "{monto}" in body["content"] and "Back office" in body["content"]


@pytest.mark.asyncio
async def test_extract_template_rejects_empty_unsupported_and_textless_files(client):
    empty = await client.post(f"{API}/extract", files={"file": ("vacio.txt", b"", "text/plain")})
    unsupported = await client.post(f"{API}/extract", files={"file": ("programa.exe", b"MZ", "application/octet-stream")})
    textless = await client.post(f"{API}/extract", files={"file": ("sin_texto.docx", _docx_bytes([]), DOCX_MIME)})
    assert empty.status_code == 400
    assert unsupported.status_code == 400
    assert "Supported formats" in unsupported.json()["detail"]
    assert textless.status_code == 400


@pytest.mark.asyncio
async def test_extract_template_corrupt_docx_and_pdf_return_400(client):
    """RF07-D-001: un .docx o .pdf corrupto debe dar 400 controlado, no 500."""
    docx_resp = await client.post(f"{API}/extract", files={"file": ("falso.docx", b"esto no es un word", DOCX_MIME)})
    pdf_resp = await client.post(f"{API}/extract", files={"file": ("falso.pdf", b"esto no es un pdf", "application/pdf")})
    assert docx_resp.status_code == 400
    assert "Word" in docx_resp.json()["detail"]
    assert pdf_resp.status_code == 400
    assert "PDF" in pdf_resp.json()["detail"]
