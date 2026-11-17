"""RF-VTA-03 · propuesta vinculada al cliente, copia del perfil al generar y contenido según industria y tamaño.
Los nombres de las pruebas llevan el ID del caso del plan (RF03-PA-xx)."""
from __future__ import annotations

from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

import pytest

from app.workers.tasks.proposal_tasks import _generate_proposal_content
from tests.conftest import FAKE_USER_SUB, fake_job

PROPOSALS = "/api/v1/proposals"
R = "app.routers.proposals"
W = "app.workers.tasks.proposal_tasks"

BANCO = {"id": "cust-bank", "userId": FAKE_USER_SUB, "name": "Marcela Rojas", "email": "m@banco-demo.com",
         "company": "Banco Horizonte", "industry": "financial_services", "size": "large"}
TIENDA = {"id": "cust-shop", "userId": FAKE_USER_SUB, "name": "Felipe Soto", "email": "f@tienda-demo.com",
          "company": "Tienda Luz", "industry": "retail_ecommerce", "size": "micro"}
SIN_PERFIL = {"id": "cust-old", "userId": FAKE_USER_SUB, "name": "Cliente Antiguo", "email": "a@antiguo-demo.com"}
AJENO = {"id": "cust-other", "userId": "otro-usuario", "name": "Ajeno", "email": "x@ajeno-demo.com",
         "industry": "healthcare", "size": "small"}

GENERATED = {"content": "<p>x</p>", "downloadUrl": "x", "filePath": "x"}


def customers_get(*docs):
    """customers_repo.get que devuelve el cliente cuyo id se pide (o None)."""
    index = {d["id"]: d for d in docs}
    return AsyncMock(side_effect=lambda cid: index.get(cid))


def saved(extra: dict | None = None) -> dict:
    base = {"id": "p1", "userId": FAKE_USER_SUB, "title": "T", "status": "generated", "language": "es"}
    base.update(extra or {})
    return base


class Env:
    """Parches comunes de la generación: IA simulada, repos y worker en línea (sync)."""

    def __init__(self, customers, proposal=None):
        self.stack = ExitStack()
        self.customers_get = customers_get(*customers)
        self.proposal = proposal
        self.created = AsyncMock(side_effect=lambda data, doc_id=None: {**data, "id": doc_id or "p-new"})
        self.updated = AsyncMock(side_effect=lambda pid, data: saved({**(proposal or {}), **data}))
        self.gen = AsyncMock(return_value=GENERATED)

    def __enter__(self):
        e = self.stack.enter_context
        e(patch(f"{R}.customers_repo.get", self.customers_get))
        e(patch(f"{R}.proposals_repo.create", self.created))
        e(patch(f"{R}.proposals_repo.update", self.updated))
        e(patch(f"{R}.proposals_repo.get", AsyncMock(return_value=self.proposal)))
        e(patch(f"{R}.jobs_repo.create_job", new_callable=AsyncMock, return_value=fake_job()))
        e(patch(f"{W}.jobs_repo.update_progress", new_callable=AsyncMock))
        e(patch(f"{W}.jobs_repo.complete_job", new_callable=AsyncMock))
        e(patch(f"{W}._generate_proposal_content", self.gen))
        return self

    def __exit__(self, *exc):
        return self.stack.__exit__(*exc)

    def copy_written(self):
        """Lo que el router escribió en la propuesta sobre el cliente."""
        merged = {}
        for call in self.updated.await_args_list:
            merged.update({k: v for k, v in call.args[1].items() if k in ("customerId", "clientIndustry", "clientSize")})
        for call in self.created.await_args_list:
            merged.update({k: v for k, v in call.args[0].items() if k in ("customerId", "clientIndustry", "clientSize")})
        return merged


async def draft(client, **body):
    return await client.post(f"{PROPOSALS}/generate-draft", json={"title": "T", "sync": True, **body})


# ── PA-07 · propuestas vinculadas al cliente ──────────────────────────────────
class TestPA07:
    async def test_RF03_PA_07_dos_propuestas_para_el_mismo_cliente_guardan_su_identificador(self, client):
        with Env([BANCO]) as env:
            for _ in range(2):
                resp = await client.post(PROPOSALS, json={"title": "Propuesta", "customerId": "cust-bank"})
                assert resp.status_code == 201 and resp.json()["customerId"] == "cust-bank"
        assert [c.args[0]["customerId"] for c in env.created.await_args_list] == ["cust-bank", "cust-bank"]

    async def test_RF03_PA_07_generar_borrador_guarda_el_vinculo_y_la_copia(self, client):
        with Env([BANCO]) as env:
            resp = await draft(client, customerId="cust-bank")
        assert resp.status_code == 201
        assert env.copy_written() == {"customerId": "cust-bank", "clientIndustry": "financial_services", "clientSize": "large"}

    async def test_RF03_PA_07_el_worker_recibe_el_perfil_del_cliente(self, client):
        with Env([BANCO]) as env:
            await draft(client, customerId="cust-bank")
        kwargs = env.gen.await_args.kwargs
        assert (kwargs["client_industry"], kwargs["client_size"]) == ("financial_services", "large")

    async def test_RF03_PA_07_sin_cliente_no_hay_vinculo(self, client):
        with Env([]) as env:
            resp = await client.post(PROPOSALS, json={"title": "Propuesta"})
        assert resp.status_code == 201 and "customerId" not in env.created.await_args.args[0]


# ── PA-11 · clientes ajenos o inexistentes ────────────────────────────────────
class TestPA11:
    @pytest.mark.parametrize("customer_id,expected", [("cust-other", 403), ("no-existe", 404)])
    async def test_RF03_PA_11_crear_con_cliente_ajeno_o_inexistente_se_rechaza(self, client, customer_id, expected):
        with Env([AJENO]) as env:
            resp = await client.post(PROPOSALS, json={"title": "P", "customerId": customer_id})
        assert resp.status_code == expected
        env.created.assert_not_awaited()

    @pytest.mark.parametrize("customer_id,expected", [("cust-other", 403), ("no-existe", 404)])
    async def test_RF03_PA_11_generate_draft_con_cliente_ajeno_o_inexistente_no_deja_propuestas_huerfanas(self, client, customer_id, expected):
        with Env([AJENO]) as env:
            resp = await draft(client, customerId=customer_id)
        assert resp.status_code == expected
        env.created.assert_not_awaited()
        env.gen.assert_not_awaited()

    @pytest.mark.parametrize("customer_id,expected", [("cust-other", 403), ("no-existe", 404)])
    async def test_RF03_PA_11_generate_por_id_con_cliente_ajeno_o_inexistente(self, client, customer_id, expected):
        with Env([AJENO], proposal=saved()) as env:
            resp = await client.post(f"{PROPOSALS}/p1/generate", json={"sync": True, "customerId": customer_id})
        assert resp.status_code == expected
        env.gen.assert_not_awaited()

    async def test_RF03_PA_11_una_propuesta_vinculada_no_cambia_de_cliente(self, client):
        with Env([BANCO, TIENDA], proposal=saved({"customerId": "cust-bank"})) as env:
            resp = await client.post(f"{PROPOSALS}/p1/generate", json={"sync": True, "customerId": "cust-shop"})
        assert resp.status_code == 409
        env.gen.assert_not_awaited()

    async def test_RF03_PA_11_el_vinculo_no_se_cambia_por_edicion(self, client):
        with Env([BANCO], proposal=saved({"customerId": "cust-bank"})) as env:
            resp = await client.put(f"{PROPOSALS}/p1", json={"title": "Nuevo título", "customerId": "cust-shop"})
        assert resp.status_code == 200
        written = env.updated.await_args.args[1]
        assert "customerId" not in written and written["title"] == "Nuevo título"

    async def test_RF03_PA_11_el_navegador_no_puede_escribir_la_copia_del_perfil(self, client):
        with Env([BANCO]) as env:
            await client.post(PROPOSALS, json={"title": "P", "clientIndustry": "healthcare", "clientSize": "micro"})
            await draft(client, customerId="cust-bank", clientIndustry="healthcare", clientSize="micro")
        assert "clientIndustry" not in env.created.await_args_list[0].args[0]
        kwargs = env.gen.await_args.kwargs
        assert (kwargs["client_industry"], kwargs["client_size"]) == ("financial_services", "large")  # sale del cliente guardado


# ── PA-13 / PA-14 · contenido según industria y tamaño ────────────────────────
async def prompt_for(**kwargs) -> str:
    with (
        patch(f"{R}._output_dir", return_value=__import__("pathlib").Path(__import__("tempfile").mkdtemp())),
        patch(f"{R}.deepseek_service.generate_text", new_callable=AsyncMock, return_value="<p>ok</p>") as gen,
        patch(f"{W}.get_rag_context_and_sources", new_callable=AsyncMock, return_value=("", [])),
    ):
        await _generate_proposal_content("Propuesta", "Cliente", "Cobranza telefónica", **kwargs)
    return gen.await_args.args[0]


class TestPA13:
    async def test_RF03_PA_13_cada_borrador_lleva_la_industria_y_el_tamano_de_su_cliente(self):
        banco = await prompt_for(language="es", client_industry="financial_services", client_size="large")
        tienda = await prompt_for(language="es", client_industry="retail_ecommerce", client_size="micro")
        assert "Client industry: Servicios financieros" in banco and "Client size: Grande (200+ employees)" in banco
        assert "Client industry: Retail y e-commerce" in tienda and "Client size: Micro (1-9 employees)" in tienda
        # sin mezclar los del otro cliente
        assert "Retail" not in banco and "Micro" not in banco
        assert "Servicios financieros" not in tienda and "Grande" not in tienda

    @pytest.mark.parametrize("lang,industry,size", [
        ("en", "Financial services", "Large (200+ employees)"),
        ("pt", "Serviços financeiros", "Grande (200+ employees)"),
        ("es", "Servicios financieros", "Grande (200+ employees)"),
    ])
    async def test_RF03_PA_13_las_etiquetas_siguen_el_idioma_de_la_propuesta(self, lang, industry, size):
        prompt = await prompt_for(language=lang, client_industry="financial_services", client_size="large")
        assert f"Client industry: {industry}" in prompt and f"Client size: {size}" in prompt

    async def test_RF03_PA_13_pide_adaptar_el_texto_al_perfil(self):
        prompt = await prompt_for(language="es", client_industry="financial_services", client_size="large")
        assert "Adapt the proposal to the client's industry and size" in prompt
        assert "is not provided" not in prompt  # no hay nada faltante que marcar como supuesto


class TestPA14:
    async def test_RF03_PA_14_sin_perfil_el_prompt_prohibe_inventarlo(self):
        prompt = await prompt_for(language="es")
        assert "Client industry: Not provided" in prompt and "Client size: Not provided" in prompt
        assert "do not state, guess or invent it" in prompt and "Assumption" in prompt
        assert "Adapt the proposal to the client's" not in prompt

    async def test_RF03_PA_14_con_solo_la_industria_marca_el_tamano_como_faltante(self):
        prompt = await prompt_for(language="es", client_industry="healthcare")
        assert "Client industry: Salud" in prompt and "Client size: Not provided" in prompt
        assert "Adapt the proposal to the client's industry given above" in prompt
        assert "The client's size is not provided" in prompt

    async def test_RF03_PA_14_cliente_vinculado_sin_perfil_no_inventa_nada(self, client):
        with Env([SIN_PERFIL]) as env:
            await draft(client, customerId="cust-old")
        kwargs = env.gen.await_args.kwargs
        assert kwargs["client_industry"] is None and kwargs["client_size"] is None

    async def test_RF03_PA_14_propuesta_sin_cliente_se_genera_como_antes(self, client):
        with Env([]) as env:
            resp = await draft(client)
        assert resp.status_code == 201
        env.customers_get.assert_not_awaited()
        assert env.gen.await_args.kwargs["client_industry"] is None


# ── PA-15 · la copia se toma al generar ───────────────────────────────────────
class TestPA15:
    async def test_RF03_PA_15_la_propuesta_conserva_la_copia_hasta_que_se_regenera(self, client):
        # 1) se genera con el perfil de entonces: Retail / Micro
        with Env([TIENDA], proposal=saved({"customerId": "cust-shop"})) as env:
            await client.post(f"{PROPOSALS}/p1/generate", json={"sync": True})
        assert env.copy_written() == {"customerId": "cust-shop", "clientIndustry": "retail_ecommerce", "clientSize": "micro"}

        # 2) el cliente cambia a Servicios financieros / Grande: no se toca ninguna propuesta
        cambiado = {**TIENDA, "industry": "financial_services", "size": "large"}
        with (
            patch("app.routers.customers.customers_repo.get", new_callable=AsyncMock, return_value=cambiado),
            patch("app.routers.customers.customers_repo.update", new_callable=AsyncMock, return_value=cambiado),
            patch("app.routers.proposals.proposals_repo.update", new_callable=AsyncMock) as proposal_update,
        ):
            resp = await client.put("/api/v1/customers/cust-shop", json={"industry": "financial_services", "size": "large"})
        assert resp.status_code == 200
        proposal_update.assert_not_awaited()  # editar al cliente no cambia las propuestas ya generadas

        # 3) una generación nueva toma el perfil nuevo
        with Env([cambiado], proposal=saved({"customerId": "cust-shop", "clientIndustry": "retail_ecommerce", "clientSize": "micro"})) as env2:
            await client.post(f"{PROPOSALS}/p1/generate", json={"sync": True})
        assert env2.copy_written() == {"customerId": "cust-shop", "clientIndustry": "financial_services", "clientSize": "large"}
        assert (env2.gen.await_args.kwargs["client_industry"], env2.gen.await_args.kwargs["client_size"]) == ("financial_services", "large")

    async def test_RF03_PA_15_regenerar_sin_enviar_cliente_conserva_el_vinculo(self, client):
        with Env([BANCO], proposal=saved({"customerId": "cust-bank"})) as env:
            resp = await client.post(f"{PROPOSALS}/p1/generate", json={"sync": True})
        assert resp.status_code == 200
        assert env.gen.await_args.kwargs["client_industry"] == "financial_services"


# ── Regresión: propuestas antiguas ────────────────────────────────────────────
class TestRegresion:
    async def test_propuesta_antigua_sin_customerId_se_genera_sin_consultar_clientes(self, client):
        with Env([BANCO], proposal=saved()) as env:
            resp = await client.post(f"{PROPOSALS}/p1/generate", json={"sync": True})
        assert resp.status_code == 200
        env.customers_get.assert_not_awaited()
        assert env.copy_written() == {}

    def test_los_campos_de_copia_son_solo_del_servidor(self):
        from app.schemas.proposal import SERVER_ONLY_FIELDS, strip_server_only_fields
        assert {"clientIndustry", "clientSize"} <= set(SERVER_ONLY_FIELDS)
        assert strip_server_only_fields({"clientIndustry": "x", "title": "t"}) == {"title": "t"}
