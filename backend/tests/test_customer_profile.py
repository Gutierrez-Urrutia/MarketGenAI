"""RF-VTA-03 · perfil del cliente (industria y tamaño), historial y eliminación segura.
Los nombres de las pruebas llevan el ID del caso del plan (RF03-PA-xx)."""
from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.dependencies.auth import CurrentUser, get_current_user
from app.middleware.audit import _infer_action
from app.services.customer_profile_service import (
    INDUSTRY_CODES, SIZE_CODES, parse_industry, parse_size, profile_options,
)
from tests.conftest import FAKE_USER_SUB

API = "/api/v1/customers"
CUST = "app.routers.customers.customers_repo"
PROP = "app.routers.customers.proposals_repo"


def fake_customer(overrides: dict | None = None) -> dict:
    base = {
        "id": "cust-001", "userId": FAKE_USER_SUB, "name": "Marcela Rojas", "email": "marcela@bancohorizonte-demo.com",
        "company": "Banco Horizonte", "phone": None, "notes": None, "industry": "financial_services", "size": "large",
        "createdAt": "2026-11-01T00:00:00Z", "updatedAt": "2026-11-01T00:00:00Z",
    }
    base.update(overrides or {})
    return base


def fake_proposal(pid: str, days_ago: int, status: str = "Generada", owner: str = FAKE_USER_SUB) -> dict:
    created = datetime(2026, 11, 10, tzinfo=timezone.utc) - timedelta(days=days_ago)
    return {"id": pid, "userId": owner, "customerId": "cust-001", "title": f"Propuesta {pid}",
            "status": "generated", "proposal_status": status, "createdAt": created}


# ── cliente para un segundo usuario (aislamiento) ─────────────────────────────
@pytest_asyncio.fixture
async def other_client(app):
    previous = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        sub="otro-usuario", email="otro@noondalton.com", roles=["user"], raw={"sub": "otro-usuario"})
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as ac:
            yield ac
    finally:
        if previous is not None:
            app.dependency_overrides[get_current_user] = previous


async def create(client, **fields):
    body = {"name": "Marcela Rojas", "email": "marcela@bancohorizonte-demo.com", **fields}

    async def _create(data):
        return {**data, "id": "cust-new", "createdAt": "2026-11-12T00:00:00Z", "updatedAt": "2026-11-12T00:00:00Z"}

    with patch(f"{CUST}.create", side_effect=_create):
        return await client.post(API, json=body)


# ── PA-01 · registrar industria y tamaño ──────────────────────────────────────
class TestPA01:
    async def test_RF03_PA_01_crear_con_industria_y_tamano(self, client):
        resp = await create(client, industry="financial_services", size="medium")
        assert resp.status_code == 201
        data = resp.json()
        assert data["industry"] == "financial_services" and data["size"] == "medium"
        assert data["industryLabel"] == "Servicios financieros" and data["sizeLabel"] == "Mediana"

    async def test_RF03_PA_01_editar_el_tamano_y_ver_la_ficha(self, client):
        before = fake_customer({"size": "medium"})
        after = fake_customer({"size": "large"})
        with (
            patch(f"{CUST}.get", new_callable=AsyncMock, return_value=before),
            patch(f"{CUST}.update", new_callable=AsyncMock, return_value=after) as upd,
        ):
            resp = await client.put(f"{API}/cust-001", json={"size": "large"})
        assert resp.status_code == 200 and resp.json()["size"] == "large"
        assert upd.call_args.args[1] == {"size": "large"}
        with patch(f"{CUST}.get", new_callable=AsyncMock, return_value=after):
            ficha = await client.get(f"{API}/cust-001")
        assert ficha.json()["sizeLabel"] == "Grande"

    async def test_RF03_PA_01_las_etiquetas_siguen_el_idioma(self, client):
        with patch(f"{CUST}.get", new_callable=AsyncMock, return_value=fake_customer()):
            for lang, industria, tamano in (("en", "Financial services", "Large"), ("pt", "Serviços financeiros", "Grande"), ("es", "Servicios financieros", "Grande")):
                resp = await client.get(f"{API}/cust-001", headers={"Accept-Language": lang})
                assert (resp.json()["industryLabel"], resp.json()["sizeLabel"]) == (industria, tamano)

    async def test_RF03_PA_01_options_trae_industrias_y_tamanos_en_tres_idiomas(self, client):
        data = (await client.get(f"{API}/options")).json()
        assert [i["value"] for i in data["industries"]] == INDUSTRY_CODES
        assert [s["value"] for s in data["sizes"]] == SIZE_CODES == ["micro", "small", "medium", "large"]
        for item in data["industries"] + data["sizes"]:
            assert set(item["labels"]) == {"es", "en", "pt"}


# ── PA-02 / PA-03 · valores no previstos ──────────────────────────────────────
class TestPA02:
    async def test_RF03_PA_02_tamano_no_previsto_da_422_con_los_valores_validos(self, client):
        resp = await create(client, size="gigante")
        assert resp.status_code == 422
        err = resp.json()["detail"][0]
        assert err["loc"][-1] == "size" and "micro, small, medium, large" in err["msg"]

    async def test_RF03_PA_02_codigo_valido_en_minusculas_y_vacio(self, client):
        assert (await create(client, size="large")).status_code == 201
        resp = await create(client, size="")
        assert resp.status_code == 201 and resp.json()["size"] is None

    @pytest.mark.parametrize("value", [-1, 5, ["large"], "Grande"])
    async def test_RF03_PA_02_otros_valores_no_previstos(self, client, value):
        assert (await create(client, size=value)).status_code == 422  # en la API solo valen los códigos


class TestPA03:
    async def test_RF03_PA_03_industria_no_prevista_da_422_con_las_industrias_validas(self, client):
        resp = await create(client, industry="mineria")
        assert resp.status_code == 422
        err = resp.json()["detail"][0]
        assert err["loc"][-1] == "industry" and "financial_services" in err["msg"]

    async def test_RF03_PA_03_industria_valida_se_acepta(self, client):
        resp = await create(client, industry="healthcare")
        assert resp.status_code == 201 and resp.json()["industryLabel"] == "Salud"

    async def test_RF03_PA_03_editar_con_industria_no_prevista_da_422(self, client):
        with patch(f"{CUST}.get", new_callable=AsyncMock, return_value=fake_customer()):
            assert (await client.put(f"{API}/cust-001", json={"industry": "mineria"})).status_code == 422

    def test_RF03_PA_03_las_industrias_son_las_de_RF_07(self):
        from app.schemas.template import Industry
        assert INDUSTRY_CODES == [i.value for i in Industry]


# ── PA-04 · importación CSV ───────────────────────────────────────────────────
class TestPA04:
    CSV = (
        "name,email,company,phone,industry,size\n"
        "Valeria Campos,valeria@seguros-demo.com,Seguros Central,,financial_services,medium\n"
        "Tomás Fuentes,tomas@clinica-demo.com,Clínica Norte,,Salud,large\n"
        "Paula Ibáñez,paula@logisur-demo.com,LogiSur,,logistics,gigante\n"
    )

    async def test_RF03_PA_04_importa_validas_reconoce_etiquetas_e_informa_la_invalida(self, client):
        created = []

        async def _create(data):
            created.append(data)
            return data

        with patch(f"{CUST}.create", side_effect=_create):
            resp = await client.post(f"{API}/import", files={"file": ("c.csv", io.BytesIO(self.CSV.encode("utf-8")), "text/csv")})
        assert resp.status_code == 200
        body = resp.json()
        assert body["imported"] == 2
        assert len(body["errors"]) == 1 and body["errors"][0].startswith("Row 4:") and "size" in body["errors"][0]
        assert (created[0]["industry"], created[0]["size"]) == ("financial_services", "medium")
        assert (created[1]["industry"], created[1]["size"]) == ("healthcare", "large")  # «Salud» -> healthcare

    async def test_RF03_PA_04_un_csv_antiguo_sin_las_columnas_nuevas_sigue_funcionando(self, client):
        csv_old = "name,email,company\nAlice,alice@x.com,AliceCo\n"
        with patch(f"{CUST}.create", new_callable=AsyncMock, side_effect=lambda d: d) as create:
            resp = await client.post(f"{API}/import", files={"file": ("c.csv", io.BytesIO(csv_old.encode()), "text/csv")})
        assert resp.json() == {"imported": 1, "errors": []}
        assert create.call_args.args[0]["industry"] is None and create.call_args.args[0]["size"] is None

    @pytest.mark.parametrize("label,code", [("Servicios financieros", "financial_services"), ("HEALTHCARE", "healthcare"),
                                            ("saúde", "healthcare"), ("Logística y transporte", "logistics")])
    def test_RF03_PA_04_etiquetas_en_los_tres_idiomas_sin_distinguir_acentos(self, label, code):
        assert parse_industry(label, allow_labels=True) == code

    def test_RF03_PA_04_tamanos_por_etiqueta(self):
        assert [parse_size(x, allow_labels=True) for x in ("Pequeña", "Média", "Large", "micro")] == ["small", "medium", "large", "micro"]


# ── PA-05 · cliente sin perfil (regresión) ────────────────────────────────────
class TestPA05:
    async def test_RF03_PA_05_cliente_antiguo_se_abre_y_se_edita_sin_exigir_el_perfil(self, client):
        legacy = fake_customer({"industry": None, "size": None})
        legacy.pop("industry"), legacy.pop("size")  # documento creado antes de RF-03: sin los campos
        with patch(f"{CUST}.get", new_callable=AsyncMock, return_value=legacy):
            ficha = await client.get(f"{API}/cust-001")
        assert ficha.status_code == 200
        assert ficha.json()["industry"] is None and ficha.json()["industryLabel"] is None

        with (
            patch(f"{CUST}.get", new_callable=AsyncMock, return_value=legacy),
            patch(f"{CUST}.update", new_callable=AsyncMock, return_value={**legacy, "phone": "+56 9 1111 2222"}) as upd,
        ):
            resp = await client.put(f"{API}/cust-001", json={"phone": "+56 9 1111 2222"})
        assert resp.status_code == 200
        assert upd.call_args.args[1] == {"phone": "+56 9 1111 2222"}  # no toca industria ni tamaño

    async def test_RF03_PA_05_se_puede_vaciar_la_industria_y_el_tamano(self, client):
        with (
            patch(f"{CUST}.get", new_callable=AsyncMock, return_value=fake_customer()),
            patch(f"{CUST}.update", new_callable=AsyncMock, return_value=fake_customer({"industry": None, "size": None})) as upd,
        ):
            resp = await client.put(f"{API}/cust-001", json={"industry": "", "size": None})
        assert resp.status_code == 200
        assert upd.call_args.args[1] == {"industry": None, "size": None}

    async def test_RF03_PA_05_lista_con_clientes_sin_perfil(self, client):
        sin_perfil = {k: v for k, v in fake_customer({"id": "cust-old"}).items() if k not in ("industry", "size")}
        with patch(f"{CUST}.list", new_callable=AsyncMock, return_value=[sin_perfil]):
            resp = await client.get(API)
        assert resp.status_code == 200 and resp.json()["items"][0]["industryLabel"] is None


# ── PA-06 · lista, búsqueda y filtros ─────────────────────────────────────────
class TestPA06:
    CLIENTES = [
        fake_customer({"id": "a", "name": "Marcela Rojas", "company": "Banco Horizonte", "createdAt": "2026-11-01T00:00:00Z"}),
        fake_customer({"id": "b", "name": "Felipe Soto", "company": "Tienda Luz", "industry": "retail_ecommerce", "size": "micro", "createdAt": "2026-11-03T00:00:00Z"}),
        fake_customer({"id": "c", "name": "Camila Vera", "company": "Clínica Andes", "industry": "healthcare", "size": "medium", "createdAt": "2026-11-02T00:00:00Z"}),
    ]

    async def _list(self, client, query=""):
        with patch(f"{CUST}.list", new_callable=AsyncMock, return_value=list(self.CLIENTES)) as lst:
            resp = await client.get(f"{API}{query}")
        return resp, lst

    async def test_RF03_PA_06_busca_por_nombre_o_empresa(self, client):
        resp, _ = await self._list(client, "?search=luz")
        assert [c["id"] for c in resp.json()["items"]] == ["b"]
        resp, _ = await self._list(client, "?search=VERA")
        assert [c["id"] for c in resp.json()["items"]] == ["c"]

    async def test_RF03_PA_06_los_filtros_llegan_a_firestore_y_validan_el_valor(self, client):
        _, lst = await self._list(client, "?industry=healthcare&size=medium")
        assert lst.call_args.kwargs["filters"] == [("userId", "==", FAKE_USER_SUB), ("industry", "==", "healthcare"), ("size", "==", "medium")]
        resp, _ = await self._list(client, "?size=gigante")
        assert resp.status_code == 422

    async def test_RF03_PA_06_orden_reciente_primero_y_paginacion_sobre_el_total_filtrado(self, client):
        resp, _ = await self._list(client)
        assert [c["id"] for c in resp.json()["items"]] == ["b", "c", "a"]
        resp, _ = await self._list(client, "?limit=1&offset=1")
        assert [c["id"] for c in resp.json()["items"]] == ["c"] and resp.json()["total"] == 3

    async def test_RF03_PA_06_solo_pide_los_clientes_del_usuario(self, client):
        _, lst = await self._list(client)
        assert lst.call_args.kwargs["filters"][0] == ("userId", "==", FAKE_USER_SUB)


# ── PA-08 · historial ordenado ────────────────────────────────────────────────
class TestPA08:
    async def test_RF03_PA_08_historial_de_la_mas_reciente_a_la_mas_antigua(self, client):
        props = [fake_proposal("p1", 9, "Borrador"), fake_proposal("p4", 1, "Enviada"),
                 fake_proposal("p2", 6, "Rechazada"), fake_proposal("p3", 3, "En negociación")]
        with (
            patch(f"{CUST}.get", new_callable=AsyncMock, return_value=fake_customer()),
            patch(f"{PROP}.list", new_callable=AsyncMock, return_value=props) as lst,
        ):
            resp = await client.get(f"{API}/cust-001/proposals")
        assert resp.status_code == 200
        body = resp.json()
        assert [p["id"] for p in body["items"]] == ["p4", "p3", "p2", "p1"] and body["total"] == 4
        assert body["items"][0]["proposal_status"] == "Enviada" and body["items"][0]["title"] == "Propuesta p4"
        assert lst.call_args.kwargs["filters"] == [("userId", "==", FAKE_USER_SUB), ("customerId", "==", "cust-001")]

    async def test_RF03_PA_08_pagina_con_limit_y_offset(self, client):
        props = [fake_proposal(f"p{i}", i) for i in range(1, 6)]
        with (
            patch(f"{CUST}.get", new_callable=AsyncMock, return_value=fake_customer()),
            patch(f"{PROP}.list", new_callable=AsyncMock, return_value=props),
        ):
            resp = await client.get(f"{API}/cust-001/proposals?limit=2&offset=2")
        assert [p["id"] for p in resp.json()["items"]] == ["p3", "p4"] and resp.json()["total"] == 5

    async def test_RF03_PA_08_cliente_sin_propuestas_y_limit_invalido(self, client):
        with (
            patch(f"{CUST}.get", new_callable=AsyncMock, return_value=fake_customer()),
            patch(f"{PROP}.list", new_callable=AsyncMock, return_value=[]),
        ):
            assert (await client.get(f"{API}/cust-001/proposals")).json() == {"items": [], "total": 0}
            assert (await client.get(f"{API}/cust-001/proposals?limit=101")).status_code == 422


# ── PA-09 · eliminar cliente con propuestas ───────────────────────────────────
class TestPA09:
    async def test_RF03_PA_09_con_propuestas_da_409_con_el_conteo_y_no_borra(self, client):
        with (
            patch(f"{CUST}.get", new_callable=AsyncMock, return_value=fake_customer()),
            patch(f"{PROP}.count", new_callable=AsyncMock, return_value=3),
            patch(f"{CUST}.delete", new_callable=AsyncMock) as delete,
        ):
            resp = await client.delete(f"{API}/cust-001")
        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert detail["code"] == "CUSTOMER_HAS_PROPOSALS" and detail["proposalCount"] == 3 and "3" in detail["message"]
        delete.assert_not_called()

    async def test_RF03_PA_09_sin_propuestas_se_elimina(self, client):
        with (
            patch(f"{CUST}.get", new_callable=AsyncMock, return_value=fake_customer()),
            patch(f"{PROP}.count", new_callable=AsyncMock, return_value=0) as count,
            patch(f"{CUST}.delete", new_callable=AsyncMock) as delete,
        ):
            resp = await client.delete(f"{API}/cust-001")
        assert resp.status_code == 204
        delete.assert_awaited_once_with("cust-001")
        assert count.call_args.kwargs["filters"] == [("userId", "==", FAKE_USER_SUB), ("customerId", "==", "cust-001")]


# ── PA-10 · aislamiento entre usuarios ────────────────────────────────────────
class TestPA10:
    async def test_RF03_PA_10_otro_usuario_no_consulta_edita_ni_elimina(self, other_client):
        ajeno = fake_customer()  # userId = FAKE_USER_SUB
        with (
            patch(f"{CUST}.get", new_callable=AsyncMock, return_value=ajeno),
            patch(f"{CUST}.update", new_callable=AsyncMock) as upd,
            patch(f"{CUST}.delete", new_callable=AsyncMock) as delete,
            patch(f"{PROP}.list", new_callable=AsyncMock) as props,
            patch(f"{PROP}.count", new_callable=AsyncMock, return_value=0),
        ):
            assert (await other_client.get(f"{API}/cust-001")).status_code == 403
            assert (await other_client.get(f"{API}/cust-001/proposals")).status_code == 403
            assert (await other_client.put(f"{API}/cust-001", json={"size": "micro"})).status_code == 403
            assert (await other_client.delete(f"{API}/cust-001")).status_code == 403
        upd.assert_not_called(), delete.assert_not_called(), props.assert_not_called()

    async def test_RF03_PA_10_inexistente_da_404_y_la_lista_es_solo_del_usuario(self, other_client):
        with patch(f"{CUST}.get", new_callable=AsyncMock, return_value=None):
            assert (await other_client.get(f"{API}/nope/proposals")).status_code == 404
        with patch(f"{CUST}.list", new_callable=AsyncMock, return_value=[]) as lst:
            await other_client.get(API)
        assert lst.call_args.kwargs["filters"][0] == ("userId", "==", "otro-usuario")

    async def test_RF03_PA_10_el_perfil_no_se_puede_crear_a_nombre_de_otro_usuario(self, client):
        captured = {}

        async def _create(data):
            captured.update(data)
            return {**data, "id": "x"}

        with patch(f"{CUST}.create", side_effect=_create):
            await client.post(API, json={"name": "X", "email": "x@x.com", "userId": "otro-usuario"})
        assert captured["userId"] == FAKE_USER_SUB


# ── PA-16 · auditoría ─────────────────────────────────────────────────────────
class TestPA16:
    @pytest.mark.parametrize("method,path,action", [
        ("POST", "/api/v1/customers", "created_customer"),
        ("PUT", "/api/v1/customers/cust-001", "updated_customer"),
        ("DELETE", "/api/v1/customers/cust-001", "deleted_customer"),
        ("POST", "/api/v1/customers/import", "imported_customers"),
    ])
    def test_RF03_PA_16_reglas_de_auditoria_de_clientes(self, method, path, action):
        assert _infer_action(method, path) == action

    def test_RF03_PA_16_no_cambia_la_auditoria_del_catalogo_ni_de_propuestas(self):
        assert _infer_action("POST", "/api/v1/catalog/services") == "created_service"
        assert _infer_action("POST", "/api/v1/proposals") == "created_proposal"


def test_options_es_deterministico():
    assert profile_options()["sizes"][0] == {"value": "micro", "labels": {"es": "Micro", "en": "Micro", "pt": "Micro"}, "employees": "1-9"}
