"""Tests for the /api/v1/catalog router (RF-VTA-02). Test names carry the case ID of the plan."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.dependencies.auth import CurrentUser, get_current_user
from app.middleware.audit import _infer_action
from app.services.firestore_service import DuplicateKeyError, UniqueKeyedRepo

API = "/api/v1/catalog"
SERVICES = f"{API}/services"
TYPES = f"{API}/service-types"
SVC = "app.routers.catalog.service_catalog_repo"
TYP = "app.routers.catalog.service_types_repo"


# ── Fixtures: one client per role ─────────────────────────────────────────────
def _user_with(role: str, sub: str) -> CurrentUser:
    return CurrentUser(sub=sub, email=f"{sub}@noondalton.com", name=sub, roles=[role], raw={"sub": sub})


async def _client_as(app, role: str | None):
    previous = app.dependency_overrides.get(get_current_user)
    if role is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: _user_with(role, f"{role}-sub")
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as ac:
            yield ac
    finally:
        if previous is not None:
            app.dependency_overrides[get_current_user] = previous


@pytest_asyncio.fixture
async def user_client(app):
    async for ac in _client_as(app, "user"):
        yield ac


@pytest_asyncio.fixture
async def manager_client(app):
    async for ac in _client_as(app, "manager"):
        yield ac


@pytest_asyncio.fixture
async def admin_client(app):
    async for ac in _client_as(app, "admin"):
        yield ac


@pytest_asyncio.fixture(params=["manager", "admin"])
async def writer_client(app, request):
    async for ac in _client_as(app, request.param):
        yield ac


@pytest_asyncio.fixture
async def anon_client(app):
    async for ac in _client_as(app, None):
        yield ac


# ── Fake documents ────────────────────────────────────────────────────────────
def fake_type(overrides: dict | None = None) -> dict:
    base = {
        "id": "type-001", "name": "Soporte técnico", "active": True,
        "createdBy": "manager-sub", "updatedBy": "manager-sub",
        "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-01-01T00:00:00Z",
    }
    base.update(overrides or {})
    return base


def fake_service(overrides: dict | None = None) -> dict:
    base = {
        "id": "svc-001", "name": "Mesa de ayuda", "description": "", "unit": "hora",
        "typeId": "type-001", "price": 25.5, "currency": "USD", "conditions": "Pago a 30 días",
        "active": True, "createdBy": "manager-sub", "updatedBy": "manager-sub",
        "uniqueKey": "k", "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-01-01T00:00:00Z",
    }
    base.update(overrides or {})
    return base


def body(overrides: dict | None = None) -> dict:
    base = {
        "name": "Mesa de ayuda", "unit": "hora", "typeId": "type-001",
        "price": 25.5, "currency": "USD", "conditions": "Pago a 30 días",
    }
    base.update(overrides or {})
    return base


def create_returns_input(**_):
    """create_unique stand-in that echoes what the router would persist."""
    async def _create(data, key):
        return {**data, "id": "svc-new", "uniqueKey": key,
                "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-01-01T00:00:00Z"}
    return _create


async def post_service(client, payload, type_doc=None):
    with (
        patch(f"{TYP}.get", new_callable=AsyncMock, return_value=type_doc if type_doc is not None else fake_type()),
        patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[fake_type()]),
        patch(f"{SVC}.create_unique", side_effect=create_returns_input()),
    ):
        return await client.post(SERVICES, json=payload)


# ── PA-01 · crear, editar, desactivar y auditoría ─────────────────────────────
class TestPA01:
    async def test_RF02_PA_01_crear_editar_desactivar(self, manager_client):
        resp = await post_service(manager_client, body())
        assert resp.status_code == 201
        data = resp.json()
        assert data["createdBy"] == "manager-sub" and data["updatedBy"] == "manager-sub"
        assert data["active"] is True and data["typeName"] == "Soporte técnico"

        with (
            patch(f"{SVC}.get", new_callable=AsyncMock, return_value=fake_service()),
            patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[fake_type()]),
            patch(f"{SVC}.update_unique", new_callable=AsyncMock,
                  return_value=fake_service({"price": 30, "updatedBy": "manager-sub"})) as upd,
        ):
            resp = await manager_client.patch(f"{SERVICES}/svc-001", json={"price": 30})
        assert resp.status_code == 200 and resp.json()["price"] == 30
        sent = upd.call_args.args[1]
        assert sent["updatedBy"] == "manager-sub" and sent["price"] == 30
        assert upd.call_args.args[2] is None  # name/unit untouched: key unchanged

        with (
            patch(f"{SVC}.get", new_callable=AsyncMock, return_value=fake_service()),
            patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[fake_type()]),
            patch(f"{SVC}.update_unique", new_callable=AsyncMock,
                  return_value=fake_service({"active": False})),
        ):
            resp = await manager_client.patch(f"{SERVICES}/svc-001", json={"active": False})
        assert resp.status_code == 200 and resp.json()["active"] is False

    def test_RF02_PA_01_reglas_de_auditoria(self):
        assert _infer_action("POST", "/api/v1/catalog/services") == "created_service"
        assert _infer_action("PATCH", "/api/v1/catalog/services/svc-001") == "updated_service"
        assert _infer_action("POST", "/api/v1/catalog/service-types") == "created_service_type"
        assert _infer_action("PATCH", "/api/v1/catalog/service-types/t1") == "updated_service_type"

    async def test_RF02_PA_01_auditoria_registra_desactivacion(self, app, manager_client):
        """The router tags the request so the audit middleware logs `deactivated_service`."""
        logged = []

        class FakeDoc:
            def set(self, log):
                logged.append(log)
                return asyncio.sleep(0)

        class FakeDb:
            def collection(self, _name):
                return self

            def document(self, _id):
                return FakeDoc()

        with (
            patch("app.middleware.audit.settings.audit_log_enabled", True),
            patch("app.services.firestore_service.get_db", return_value=FakeDb()),
            patch(f"{SVC}.get", new_callable=AsyncMock, return_value=fake_service()),
            patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[fake_type()]),
            patch(f"{SVC}.update_unique", new_callable=AsyncMock,
                  return_value=fake_service({"active": False})),
        ):
            resp = await manager_client.patch(f"{SERVICES}/svc-001", json={"active": False})
        assert resp.status_code == 200
        assert [log["action"] for log in logged] == ["deactivated_service"]


# ── PA-02 · validación de campos ──────────────────────────────────────────────
class TestPA02:
    @pytest.mark.parametrize("field", ["name", "unit", "price", "typeId", "currency"])
    async def test_RF02_PA_02_campo_obligatorio(self, manager_client, field):
        payload = body()
        payload.pop(field)
        resp = await post_service(manager_client, payload)
        assert resp.status_code == 422
        assert any(field in err["loc"] for err in resp.json()["detail"])

    @pytest.mark.parametrize("overrides", [
        {"name": "   "}, {"unit": ""}, {"price": ""}, {"price": None}, {"price": "abc"},
        {"price": -5}, {"currency": "EUR"}, {"name": "x" * 201}, {"unit": "x" * 51},
    ])
    async def test_RF02_PA_02_valores_invalidos(self, manager_client, overrides):
        resp = await post_service(manager_client, body(overrides))
        assert resp.status_code == 422

    async def test_RF02_PA_02_nombre_200_y_unidad_50_se_aceptan(self, manager_client):
        resp = await post_service(manager_client, body({"name": "x" * 200, "unit": "u" * 50}))
        assert resp.status_code == 201


# ── PA-03 · duplicados ────────────────────────────────────────────────────────
class TestPA03:
    async def test_RF02_PA_03_mismo_nombre_y_unidad_da_409(self, manager_client):
        with (
            patch(f"{TYP}.get", new_callable=AsyncMock, return_value=fake_type()),
            patch(f"{SVC}.create_unique", new_callable=AsyncMock, side_effect=DuplicateKeyError("k")),
        ):
            resp = await manager_client.post(SERVICES, json=body())
        assert resp.status_code == 409

    async def test_RF02_PA_03_distinta_unidad_da_201(self, manager_client):
        resp = await post_service(manager_client, body({"unit": "mes", "price": 4200}))
        assert resp.status_code == 201

    def test_RF02_PA_03_la_clave_ignora_mayusculas_y_espacios(self):
        key = UniqueKeyedRepo.make_key("Mesa de ayuda", "hora")
        assert UniqueKeyedRepo.make_key("  MESA   de  Ayuda ", " Hora") == key
        assert UniqueKeyedRepo.make_key("Mesa de ayuda", "mes") != key

    async def test_RF02_PA_03_el_router_envia_la_clave_normalizada(self, manager_client):
        with (
            patch(f"{TYP}.get", new_callable=AsyncMock, return_value=fake_type()),
            patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[fake_type()]),
            patch(f"{SVC}.create_unique", side_effect=create_returns_input()) as create,
        ):
            await manager_client.post(SERVICES, json=body({"name": "  MESA  de ayuda ", "unit": "HORA"}))
        assert create.call_args.args[1] == UniqueKeyedRepo.make_key("Mesa de ayuda", "hora")
        assert create.call_args.args[0]["name"] == "MESA de ayuda"

    async def test_RF02_PA_03_editar_a_un_nombre_existente_da_409(self, manager_client):
        with (
            patch(f"{SVC}.get", new_callable=AsyncMock, return_value=fake_service()),
            patch(f"{SVC}.update_unique", new_callable=AsyncMock, side_effect=DuplicateKeyError("k")),
        ):
            resp = await manager_client.patch(f"{SERVICES}/svc-001", json={"unit": "mes"})
        assert resp.status_code == 409


# ── Concurrencia lógica de la clave única ─────────────────────────────────────
async def test_clave_unica_dos_creaciones_simultaneas_una_201_y_una_409(manager_client):
    """Stateful stand-in with the transaction's semantics: check-and-set on the key is atomic."""
    taken: set[str] = set()
    lock = asyncio.Lock()

    async def fake_create_unique(data, key):
        async with lock:
            await asyncio.sleep(0)
            if key in taken:
                raise DuplicateKeyError(key)
            taken.add(key)
        return {**data, "id": f"svc-{len(taken)}", "uniqueKey": key,
                "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-01-01T00:00:00Z"}

    with (
        patch(f"{TYP}.get", new_callable=AsyncMock, return_value=fake_type()),
        patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[fake_type()]),
        patch(f"{SVC}.create_unique", side_effect=fake_create_unique),
    ):
        r1, r2 = await asyncio.gather(
            manager_client.post(SERVICES, json=body()),
            manager_client.post(SERVICES, json=body({"name": " mesa DE ayuda "})),
        )
    assert sorted([r1.status_code, r2.status_code]) == [201, 409]


# ── PA-04 / PA-05 · límites de precio ─────────────────────────────────────────
class TestPA04:
    @pytest.mark.parametrize("price", [0, 10.555, -1, "0"])
    async def test_RF02_PA_04_usd_rechazados(self, manager_client, price):
        resp = await post_service(manager_client, body({"currency": "USD", "price": price}))
        assert resp.status_code == 422
        assert any("price" in err["loc"] for err in resp.json()["detail"])

    @pytest.mark.parametrize("price", [0.01, 25.5, 1000000])
    async def test_RF02_PA_04_usd_aceptados(self, manager_client, price):
        resp = await post_service(manager_client, body({"currency": "USD", "price": price}))
        assert resp.status_code == 201
        assert resp.json()["price"] == price


class TestPA05:
    @pytest.mark.parametrize("price", [0, 10.5, -1])
    async def test_RF02_PA_05_clp_rechazados(self, manager_client, price):
        resp = await post_service(manager_client, body({"currency": "CLP", "price": price}))
        assert resp.status_code == 422

    @pytest.mark.parametrize("price", [1, 1500, 1000000])
    async def test_RF02_PA_05_clp_aceptados(self, manager_client, price):
        resp = await post_service(manager_client, body({"currency": "CLP", "price": price}))
        assert resp.status_code == 201
        assert resp.json()["price"] == price

    async def test_RF02_PA_05_clp_con_cero_decimal_se_acepta_como_entero(self, manager_client):
        resp = await post_service(manager_client, body({"currency": "CLP", "price": 1500.0}))
        assert resp.status_code == 201

    async def test_RF02_PA_05_cambiar_moneda_a_clp_revalida_el_precio_guardado(self, manager_client):
        with patch(f"{SVC}.get", new_callable=AsyncMock, return_value=fake_service({"price": 25.5})):
            resp = await manager_client.patch(f"{SERVICES}/svc-001", json={"currency": "CLP"})
        assert resp.status_code == 422
        assert any("price" in err["loc"] for err in resp.json()["detail"])


# ── PA-06 · búsqueda y filtros ────────────────────────────────────────────────
class TestPA06:
    CATALOG = [
        fake_service({"id": "a", "name": "Mesa de ayuda", "unit": "hora"}),
        fake_service({"id": "b", "name": "Mesa de ayuda", "unit": "mes", "active": False}),
        fake_service({"id": "c", "name": "Cobranza preventiva", "unit": "gestión", "typeId": "type-002"}),
    ]
    TYPES = [fake_type(), fake_type({"id": "type-002", "name": "Cobranza"})]

    async def _list(self, client, query="", docs=None):
        with (
            patch(f"{SVC}.list", new_callable=AsyncMock, return_value=list(docs or self.CATALOG)) as lst,
            patch(f"{TYP}.list", new_callable=AsyncMock, return_value=self.TYPES),
        ):
            resp = await client.get(f"{SERVICES}{query}")
        return resp, lst

    async def test_RF02_PA_06_busqueda_por_parte_del_nombre(self, user_client):
        resp, _ = await self._list(user_client, "?search=MESA")
        assert resp.status_code == 200
        assert resp.json()["total"] == 2
        assert {i["id"] for i in resp.json()["items"]} == {"a", "b"}

    async def test_RF02_PA_06_filtros_de_estado_y_tipo_llegan_al_repo(self, user_client):
        _, lst = await self._list(user_client, "?active=true&type_id=type-002")
        assert lst.call_args.kwargs["filters"] == [("active", "==", True), ("typeId", "==", "type-002")]

    async def test_RF02_PA_06_resuelve_typeName_y_ordena_por_nombre(self, user_client):
        resp, _ = await self._list(user_client)
        items = resp.json()["items"]
        assert [i["name"] for i in items][0] == "Cobranza preventiva"
        assert items[0]["typeName"] == "Cobranza"

    async def test_RF02_PA_06_paginacion(self, user_client):
        resp, _ = await self._list(user_client, "?limit=1&offset=1")
        assert resp.json()["total"] == 3 and len(resp.json()["items"]) == 1

    async def test_RF02_PA_06_limit_fuera_de_rango_da_422(self, user_client):
        resp, _ = await self._list(user_client, "?limit=101")
        assert resp.status_code == 422

    async def test_RF02_PA_06_detalle_y_404(self, user_client):
        with (
            patch(f"{SVC}.get", new_callable=AsyncMock, return_value=fake_service()),
            patch(f"{TYP}.list", new_callable=AsyncMock, return_value=self.TYPES),
        ):
            assert (await user_client.get(f"{SERVICES}/svc-001")).status_code == 200
        with patch(f"{SVC}.get", new_callable=AsyncMock, return_value=None):
            assert (await user_client.get(f"{SERVICES}/nope")).status_code == 404


# ── PA-07 · condiciones ───────────────────────────────────────────────────────
class TestPA07:
    async def test_RF02_PA_07_1000_caracteres_se_aceptan(self, manager_client):
        resp = await post_service(manager_client, body({"conditions": "c" * 1000}))
        assert resp.status_code == 201

    async def test_RF02_PA_07_1001_caracteres_se_rechazan(self, manager_client):
        resp = await post_service(manager_client, body({"conditions": "c" * 1001}))
        assert resp.status_code == 422
        assert any("conditions" in err["loc"] for err in resp.json()["detail"])

    @pytest.mark.parametrize("value", ["", None])
    async def test_RF02_PA_07_condiciones_vacias_se_aceptan(self, manager_client, value):
        resp = await post_service(manager_client, body({"conditions": value}))
        assert resp.status_code == 201
        assert resp.json()["conditions"] == ""


# ── PA-08 · CRUD de tipos ─────────────────────────────────────────────────────
class TestPA08:
    async def test_RF02_PA_08_crear_renombrar_desactivar_tipo(self, manager_client):
        async def create(data, key):
            return {**data, "id": "type-new", "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-01-01T00:00:00Z"}

        with patch(f"{TYP}.create_unique", side_effect=create):
            resp = await manager_client.post(TYPES, json={"name": "  Nuevo   tipo "})
        assert resp.status_code == 201 and resp.json()["name"] == "Nuevo tipo" and resp.json()["active"] is True

        with (
            patch(f"{TYP}.get", new_callable=AsyncMock, return_value=fake_type()),
            patch(f"{TYP}.update_unique", new_callable=AsyncMock,
                  return_value=fake_type({"name": "Renombrado"})) as upd,
        ):
            resp = await manager_client.patch(f"{TYPES}/type-001", json={"name": "Renombrado"})
        assert resp.status_code == 200
        assert upd.call_args.args[2] == UniqueKeyedRepo.make_key("Renombrado")

        with (
            patch(f"{TYP}.get", new_callable=AsyncMock, return_value=fake_type()),
            patch(f"{TYP}.update_unique", new_callable=AsyncMock,
                  return_value=fake_type({"active": False})),
        ):
            resp = await manager_client.patch(f"{TYPES}/type-001", json={"active": False})
        assert resp.status_code == 200 and resp.json()["active"] is False

    async def test_RF02_PA_08_nombre_de_tipo_duplicado_da_409(self, manager_client):
        with patch(f"{TYP}.create_unique", new_callable=AsyncMock, side_effect=DuplicateKeyError("k")):
            resp = await manager_client.post(TYPES, json={"name": "Soporte técnico"})
        assert resp.status_code == 409

    async def test_RF02_PA_08_renombrar_a_nombre_existente_da_409(self, manager_client):
        with (
            patch(f"{TYP}.get", new_callable=AsyncMock, return_value=fake_type()),
            patch(f"{TYP}.update_unique", new_callable=AsyncMock, side_effect=DuplicateKeyError("k")),
        ):
            resp = await manager_client.patch(f"{TYPES}/type-001", json={"name": "Cobranza"})
        assert resp.status_code == 409

    async def test_RF02_PA_08_tipo_inexistente_da_404_y_nombre_vacio_422(self, manager_client):
        with patch(f"{TYP}.get", new_callable=AsyncMock, return_value=None):
            assert (await manager_client.patch(f"{TYPES}/nope", json={"active": False})).status_code == 404
        assert (await manager_client.post(TYPES, json={"name": "   "})).status_code == 422

    async def test_RF02_PA_08_listar_tipos_filtra_por_activo(self, manager_client):
        with patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[fake_type()]) as lst:
            resp = await manager_client.get(f"{TYPES}?active=true")
        assert resp.status_code == 200 and resp.json()["total"] == 1
        assert lst.call_args.kwargs["filters"] == [("active", "==", True)]


# ── PA-09 · rol user ──────────────────────────────────────────────────────────
class TestPA09:
    async def test_RF02_PA_09_user_recibe_403_al_modificar_tipos(self, user_client):
        assert (await user_client.post(TYPES, json={"name": "X"})).status_code == 403
        assert (await user_client.patch(f"{TYPES}/type-001", json={"active": False})).status_code == 403

    async def test_RF02_PA_09_user_puede_listar_tipos_y_servicios(self, user_client):
        with patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[fake_type()]):
            assert (await user_client.get(TYPES)).status_code == 200
            with patch(f"{SVC}.list", new_callable=AsyncMock, return_value=[fake_service()]):
                assert (await user_client.get(SERVICES)).status_code == 200


# ── PA-10 · tipo obligatorio y activo ─────────────────────────────────────────
class TestPA10:
    async def test_RF02_PA_10_sin_tipo_da_422(self, manager_client):
        payload = body()
        payload.pop("typeId")
        assert (await post_service(manager_client, payload)).status_code == 422

    async def test_RF02_PA_10_tipo_inactivo_da_422(self, manager_client):
        resp = await post_service(manager_client, body(), type_doc=fake_type({"active": False}))
        assert resp.status_code == 422
        assert resp.json()["detail"][0]["loc"] == ["body", "typeId"]

    async def test_RF02_PA_10_tipo_inexistente_da_422(self, manager_client):
        with patch(f"{TYP}.get", new_callable=AsyncMock, return_value=None):
            resp = await manager_client.post(SERVICES, json=body())
        assert resp.status_code == 422


# ── PA-11 · tipo desactivado conserva sus servicios ───────────────────────────
class TestPA11:
    async def test_RF02_PA_11_servicio_conserva_su_tipo_inactivo(self, user_client):
        inactive = fake_type({"active": False})
        with (
            patch(f"{SVC}.list", new_callable=AsyncMock, return_value=[fake_service()]),
            patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[inactive]),
        ):
            resp = await user_client.get(SERVICES)
        item = resp.json()["items"][0]
        assert item["typeId"] == "type-001" and item["typeName"] == "Soporte técnico"

    async def test_RF02_PA_11_editar_otros_campos_no_exige_tipo_activo(self, manager_client):
        with (
            patch(f"{SVC}.get", new_callable=AsyncMock, return_value=fake_service()),
            patch(f"{TYP}.get", new_callable=AsyncMock, return_value=fake_type({"active": False})) as tget,
            patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[fake_type({"active": False})]),
            patch(f"{SVC}.update_unique", new_callable=AsyncMock, return_value=fake_service({"unit": "mes"})),
        ):
            resp = await manager_client.patch(f"{SERVICES}/svc-001", json={"unit": "mes", "typeId": "type-001"})
        assert resp.status_code == 200
        tget.assert_not_called()

    async def test_RF02_PA_11_mover_a_un_tipo_inactivo_se_rechaza(self, manager_client):
        with (
            patch(f"{SVC}.get", new_callable=AsyncMock, return_value=fake_service()),
            patch(f"{TYP}.get", new_callable=AsyncMock, return_value=fake_type({"id": "t2", "active": False})),
        ):
            resp = await manager_client.patch(f"{SERVICES}/svc-001", json={"typeId": "t2"})
        assert resp.status_code == 422


# ── PA-18 · permisos por rol ──────────────────────────────────────────────────
class TestPA18:
    async def test_RF02_PA_18_user_403_en_escrituras(self, user_client):
        assert (await user_client.post(SERVICES, json=body())).status_code == 403
        assert (await user_client.patch(f"{SERVICES}/svc-001", json={"price": 1})).status_code == 403

    async def test_RF02_PA_18_manager_y_admin_pueden_escribir(self, writer_client):
        client = writer_client
        assert (await post_service(client, body())).status_code == 201
        with (
            patch(f"{SVC}.get", new_callable=AsyncMock, return_value=fake_service()),
            patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[fake_type()]),
            patch(f"{SVC}.update_unique", new_callable=AsyncMock, return_value=fake_service({"price": 9})),
        ):
            assert (await client.patch(f"{SERVICES}/svc-001", json={"price": 9})).status_code == 200

    async def test_RF02_PA_18_sin_sesion_401_o_403(self, anon_client):
        assert (await anon_client.get(SERVICES)).status_code in (401, 403)
        assert (await anon_client.post(SERVICES, json=body())).status_code in (401, 403)

    async def test_RF02_PA_18_todos_los_roles_leen(self, user_client, manager_client, admin_client):
        for client in (user_client, manager_client, admin_client):
            with (
                patch(f"{SVC}.list", new_callable=AsyncMock, return_value=[]),
                patch(f"{TYP}.list", new_callable=AsyncMock, return_value=[]),
            ):
                assert (await client.get(SERVICES)).status_code == 200


# ── Propuestas: líneas con copia del servicio y moneda única (Fase 2) ─────────
PROPOSALS = "/api/v1/proposals"


def _line(currency=None, **extra):
    line = {"service": "Mesa de ayuda", "quantity": 1, "unitPrice": 1500, **extra}
    if currency:
        line["currency"] = currency
    return line


class TestPA15:
    async def test_RF02_PA_15_monedas_mezcladas_en_generate_dan_422(self, client):
        resp = await client.post(f"{PROPOSALS}/generate-draft", json={
            "title": "T", "lineItems": [_line("USD"), _line("CLP")], "sync": True,
        })
        assert resp.status_code == 422
        assert "one currency" in str(resp.json()["detail"])

    async def test_RF02_PA_15_generate_por_id_tambien_valida(self, client):
        with patch("app.routers.proposals.proposals_repo.get", new_callable=AsyncMock,
                   return_value={"id": "p1", "userId": "test-user-sub-123", "title": "T"}):
            resp = await client.post(f"{PROPOSALS}/p1/generate", json={
                "lineItems": [_line("USD"), _line("CLP")],
            })
        assert resp.status_code == 422

    async def test_RF02_PA_15_moneda_de_la_propuesta_distinta_de_la_de_las_lineas(self, client):
        resp = await client.post(f"{PROPOSALS}/generate-draft", json={
            "title": "T", "currency": "USD", "lineItems": [_line("CLP")], "sync": True,
        })
        assert resp.status_code == 422

    async def test_RF02_PA_15_crear_y_actualizar_con_lineas_mezcladas_dan_422(self, client):
        mixed = [_line("USD"), _line("CLP")]
        assert (await client.post(PROPOSALS, json={"title": "T", "lineItems": mixed})).status_code == 422
        assert (await client.put(f"{PROPOSALS}/p1", json={"lineItems": mixed})).status_code == 422

    async def test_RF02_PA_15_moneda_no_admitida_da_422(self, client):
        resp = await client.post(f"{PROPOSALS}/generate-draft", json={"title": "T", "lineItems": [_line("EUR")]})
        assert resp.status_code == 422

    def test_RF02_PA_15_la_moneda_se_infiere_de_las_lineas_si_no_viene(self):
        from app.schemas.proposal import GenerateProposalRequest
        assert GenerateProposalRequest(lineItems=[_line("CLP")]).currency == "CLP"
        assert GenerateProposalRequest(lineItems=[_line()]).currency == "USD"
        assert GenerateProposalRequest().currency == "USD"


class TestPA16:
    def test_RF02_PA_16_total_de_dos_lineas_con_cantidades_3_y_1(self):
        from app.workers.tasks.proposal_tasks import build_pricing_table_html, format_money
        lines = [
            {"name": "Soporte técnico nivel 1", "qty": 3, "unitPrice": 18000, "currency": "CLP"},
            {"name": "Cobranza preventiva", "qty": 1, "unitPrice": 1500, "currency": "CLP"},
        ]
        html = build_pricing_table_html(lines, 55500, "es", "CLP")
        assert "$54.000 CLP" in html and "$1.500 CLP" in html  # subtotales 3 x 18.000 y 1 x 1.500
        assert format_money(3 * 18000 + 1 * 1500, "n/d", "es", "CLP") == "$55.500 CLP"

    def test_RF02_PA_16_total_en_usd_con_decimales_de_precio(self):
        from app.workers.tasks.proposal_tasks import build_pricing_table_html
        lines = [{"name": "A", "qty": 3, "unitPrice": 1000}, {"name": "B", "qty": 1, "unitPrice": 500}]
        html = build_pricing_table_html(lines, 3500, "en")
        assert "$3,000 USD" in html and "$500 USD" in html


class TestFormatoDeMoneda:
    def test_usd_se_mantiene_como_antes(self):
        from app.workers.tasks.proposal_tasks import format_money, format_usd
        assert format_usd(21950, "x", "en") == "$21,950 USD"
        assert format_usd(21950, "x", "es") == "$21.950 USD"
        assert format_money(21950, "x", "pt", "USD") == "$21.950 USD"
        assert format_money(None, "n/d", "es", "CLP") == "n/d"

    def test_clp_sin_decimales(self):
        from app.workers.tasks.proposal_tasks import format_money
        assert format_money(1500, "x", "es", "CLP") == "$1.500 CLP"
        assert format_money(1500.4, "x", "es", "CLP") == "$1.500 CLP"

    def test_envoltorio_del_router_para_exportacion(self):
        from app.routers.proposals import _format_money, _format_usd
        assert _format_usd(21950, "n/d", "es") == "$21.950 USD"
        assert _format_money(1500, "n/d", "es", "CLP") == "$1.500 CLP"
        assert _format_money("abc", "n/d", "es", "CLP") == "n/d"


class TestPropuestaAntiguaSinMoneda:
    def test_se_exporta_como_usd(self):
        from app.routers.proposals import _proposal_cover_fields
        legacy = {"id": "p1", "totalAmount": 21950, "language": "es"}
        assert _proposal_cover_fields(legacy)["total_amount_display"] == "$21.950 USD"

    def test_propuesta_en_clp_se_exporta_en_clp(self):
        from app.routers.proposals import _proposal_cover_fields
        cover = _proposal_cover_fields({"id": "p1", "totalAmount": 55500, "currency": "CLP", "language": "es"})
        assert cover["total_amount_display"] == "$55.500 CLP"

    def test_la_tabla_de_una_linea_antigua_sale_en_usd(self):
        from app.workers.tasks.proposal_tasks import build_pricing_table_html
        html = build_pricing_table_html([{"service": "X", "quantity": 1, "unitPrice": 1750}], 1750, "es")
        assert "$1.750 USD" in html

    async def test_generar_sin_moneda_guarda_usd(self, client):
        from tests.conftest import fake_job
        saved = {"id": "p1", "userId": "test-user-sub-123", "title": "T", "status": "generated"}
        with (
            patch("app.workers.tasks.proposal_tasks._generate_proposal_content", new_callable=AsyncMock,
                  return_value={"content": "<p>x</p>", "downloadUrl": "x", "filePath": "x"}) as gen,
            patch("app.routers.proposals.proposals_repo.create", new_callable=AsyncMock, return_value=saved),
            patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=fake_job()),
            patch("app.workers.tasks.proposal_tasks.jobs_repo.update_progress", new_callable=AsyncMock),
            patch("app.workers.tasks.proposal_tasks.jobs_repo.complete_job", new_callable=AsyncMock),
            patch("app.workers.tasks.proposal_tasks.proposals_repo.update", new_callable=AsyncMock,
                  return_value=saved) as upd,
        ):
            resp = await client.post(f"{PROPOSALS}/generate-draft", json={
                "title": "T", "lineItems": [{"service": "X", "quantity": 1, "unitPrice": 1750}], "sync": True,
            })
        assert resp.status_code == 201
        assert gen.await_args.kwargs["currency"] == "USD"
        assert upd.await_args_list[-1].args[1]["currency"] == "USD"


class TestPA17:
    async def test_RF02_PA_17_generar_no_lee_el_catalogo_y_usa_la_copia_enviada(self, client):
        """La propuesta guarda una copia: aunque el catálogo cambie o falle, el precio emitido es el enviado."""
        from tests.conftest import fake_job
        saved = {"id": "p1", "userId": "test-user-sub-123", "title": "T", "status": "generated"}
        boom = AsyncMock(side_effect=AssertionError("generar no debe leer el catálogo"))
        with (
            patch("app.workers.tasks.proposal_tasks._generate_proposal_content", new_callable=AsyncMock,
                  return_value={"content": "<p>x</p>", "downloadUrl": "x", "filePath": "x"}) as gen,
            patch(f"{SVC}.get", boom), patch(f"{SVC}.list", boom),
            patch("app.routers.proposals.proposals_repo.create", new_callable=AsyncMock, return_value=saved),
            patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=fake_job()),
            patch("app.workers.tasks.proposal_tasks.jobs_repo.update_progress", new_callable=AsyncMock),
            patch("app.workers.tasks.proposal_tasks.jobs_repo.complete_job", new_callable=AsyncMock),
            patch("app.workers.tasks.proposal_tasks.proposals_repo.update", new_callable=AsyncMock, return_value=saved),
        ):
            resp = await client.post(f"{PROPOSALS}/generate-draft", json={
                "title": "T", "sync": True, "currency": "CLP",
                "lineItems": [{"service": "Soporte", "quantity": 2, "unitPrice": 18000, "currency": "CLP",
                               "serviceId": "s2", "unit": "hora", "conditions": "Mínimo 40 horas"}],
            })
        assert resp.status_code == 201
        line = gen.await_args.kwargs["line_items"][0]
        assert line["unitPrice"] == 18000 and line["serviceId"] == "s2" and line["conditions"] == "Mínimo 40 horas"
        assert gen.await_args.kwargs["currency"] == "CLP"
        boom.assert_not_called()
