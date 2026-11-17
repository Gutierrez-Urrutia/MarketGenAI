"""RNF-02 · Trazabilidad y auditoría de propuestas.

Crear, generar, editar, cambiar de estado, versionar, enviar al CRM y eliminar una
propuesta registra usuario, acción, fecha e IP; un administrador puede consultar el registro.
"""
from __future__ import annotations

import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.core.client_ip import get_client_ip
from app.dependencies.auth import CurrentUser, get_current_user
from app.services import audit_service
from app.workers.tasks import proposal_tasks
from tests.conftest import FAKE_USER_EMAIL, FAKE_USER_SUB, fake_job
from tests.test_proposals import fake_proposal
from tests.test_proposals_crm import fake_settings

API = "/api/v1/proposals"
WRITE_LOG = "app.services.audit_service.write_log"
MIDDLEWARE_WRITE_LOG = "app.middleware.audit.write_log"
REPO = "app.routers.proposals.proposals_repo"


@pytest.fixture
def logs():
    """Captura lo que `audit_service` escribiría en `auditLogs`."""
    captured: list[dict] = []

    async def _capture(log):
        captured.append(log)
        return True

    with patch(WRITE_LOG, side_effect=_capture):
        yield captured


def only(logs: list[dict], action: str) -> dict:
    found = [log for log in logs if log["action"] == action]
    assert len(found) == 1, f"se esperaba 1 registro {action}, hay {len(found)}: {logs}"
    return found[0]


def assert_traced(log: dict, *, action: str, proposal_id: str = "proposal-001"):
    """Usuario, acción, fecha e IP (RNF-02) + el recurso afectado."""
    assert log["action"] == action
    assert log["userId"] == FAKE_USER_SUB
    assert log["userEmail"] == FAKE_USER_EMAIL
    assert log["timestamp"]
    assert log["ip"]
    assert log["resourceType"] == "proposal"
    assert log["resourceId"] == proposal_id
    assert log["status"] == "success"


# ── Las siete acciones ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_RNF02_crear_propuesta_registra_usuario_accion_fecha_ip(client, logs):
    with patch(f"{REPO}.create", new_callable=AsyncMock, return_value=fake_proposal()):
        resp = await client.post(API, json={"title": "Test Proposal", "clientName": "Acme Corp"})
    assert resp.status_code == 201
    assert_traced(only(logs, audit_service.PROPOSAL_CREATED), action="proposal_created")


@pytest.mark.asyncio
async def test_RNF02_generar_propuesta_registra_y_lleva_la_ip_al_worker(client, logs):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=fake_job("proposal_generation")),
        patch("app.routers.proposals.task_generate_proposal.delay") as delay,
    ):
        resp = await client.post(f"{API}/proposal-001/generate", json={"language": "en"})
    assert resp.status_code == 202
    log = only(logs, audit_service.PROPOSAL_GENERATED)
    assert_traced(log, action="proposal_generated")
    assert log["details"]["stage"] == "requested"
    options = delay.call_args.args[5]
    assert options["auditIp"] == log["ip"]


@pytest.mark.asyncio
async def test_RNF02_el_cliente_no_puede_suplantar_la_ip_de_auditoria(client, logs):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock, return_value=fake_job("proposal_generation")),
        patch("app.routers.proposals.task_generate_proposal.delay") as delay,
    ):
        await client.post(f"{API}/proposal-001/generate", json={"language": "en", "auditIp": "6.6.6.6"})
    assert delay.call_args.args[5]["auditIp"] != "6.6.6.6"


@pytest.mark.asyncio
async def test_RNF02_editar_propuesta_registra_los_campos_modificados(client, logs):
    proposal = fake_proposal()
    updated = fake_proposal({"clientName": "Nuevo"})
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=proposal),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=updated),
        patch("app.routers.proposals._auto_snapshot", new_callable=AsyncMock),
    ):
        resp = await client.put(f"{API}/proposal-001", json={"clientName": "Nuevo"})
    assert resp.status_code == 200
    log = only(logs, audit_service.PROPOSAL_UPDATED)
    assert_traced(log, action="proposal_updated")
    assert log["details"]["fields"] == ["clientName"]
    assert "Nuevo" not in str(log)   # solo los nombres de los campos, no su contenido


@pytest.mark.asyncio
async def test_RNF02_cambiar_estado_conserva_su_registro_transaccional_sin_duplicar(client, logs):
    proposal = fake_proposal({"proposal_status": "enviada"})
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=proposal),
        patch(f"{REPO}.change_status", new_callable=AsyncMock, return_value={"proposal": proposal}) as change,
        patch(MIDDLEWARE_WRITE_LOG, new_callable=AsyncMock) as middleware_log,
    ):
        resp = await client.patch(f"{API}/proposal-001/status", json={"status": "vista"})
    assert resp.status_code == 200
    kwargs = change.await_args.kwargs
    assert kwargs["actor_id"] == FAKE_USER_SUB and kwargs["actor_email"] == FAKE_USER_EMAIL
    assert kwargs["ip"]
    middleware_log.assert_not_awaited()   # ya lo escribió la transacción
    assert logs == []                     # y no se escribe un segundo registro


@pytest.mark.asyncio
async def test_RNF02_versionar_registra_guardar_y_restaurar(client, logs):
    proposal = fake_proposal()
    version = {"id": "v-1", "version": 1, "label": "Hito", "source": "manual"}
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals._save_version", new_callable=AsyncMock, return_value=version),
    ):
        resp = await client.post(f"{API}/proposal-001/versions", json={"label": "Hito"})
    assert resp.status_code == 200
    log = only(logs, audit_service.PROPOSAL_VERSION_SAVED)
    assert_traced(log, action="proposal_version_saved")
    assert log["details"]["versionId"] == "v-1"

    logs.clear()
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=proposal),
        patch(f"{REPO}.get_version", new_callable=AsyncMock, return_value=version),
        patch(f"{REPO}.version_restore_fields", return_value={"content": "x"}),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=proposal),
        patch(f"{REPO}.create_version", new_callable=AsyncMock),
        patch("app.routers.proposals._save_version", new_callable=AsyncMock),
    ):
        resp = await client.post(f"{API}/proposal-001/versions/v-1/restore")
    assert resp.status_code == 200
    assert_traced(only(logs, audit_service.PROPOSAL_VERSION_RESTORED), action="proposal_version_restored")


@pytest.mark.asyncio
async def test_RNF02_enviar_al_crm_registra_exito(client, logs):
    proposal = fake_proposal({"clientEmail": "client@example.com", "totalAmount": 1500})
    updated = {**proposal, "crmSync": {"provider": "hubspot", "status": "synced"}}
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_settings()),
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build,
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=updated),
    ):
        build.return_value.upsert_contact = AsyncMock(return_value="c-1")
        build.return_value.upsert_deal = AsyncMock(return_value="d-1")
        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})
    assert resp.status_code == 200
    log = only(logs, audit_service.PROPOSAL_SENT_TO_CRM)
    assert_traced(log, action="proposal_sent_to_crm")
    assert log["details"]["provider"] == "hubspot"


@pytest.mark.asyncio
async def test_RNF02_enviar_al_crm_fallido_tambien_queda_registrado(client, logs):
    from app.services.crm_service import CrmAuthError

    proposal = fake_proposal({"clientEmail": "client@example.com"})
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=proposal),
        patch("app.routers.proposals.settings_repo.get_by_user", new_callable=AsyncMock, return_value=fake_settings()),
        patch("app.routers.proposals.crm_service.build_client_from_stored") as build,
        patch(f"{REPO}.update", new_callable=AsyncMock),
    ):
        build.return_value.upsert_contact = AsyncMock(side_effect=CrmAuthError("token vencido"))
        resp = await client.post(f"{API}/proposal-001/send-to-crm", json={})
    assert resp.status_code == 401
    log = only(logs, audit_service.PROPOSAL_SENT_TO_CRM)
    assert log["status"] == "failed" and log["userId"] == FAKE_USER_SUB and log["ip"]


@pytest.mark.asyncio
async def test_RNF02_eliminar_propuesta_registra_con_su_titulo(client, logs):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.delete", new_callable=AsyncMock),
        patch(f"{REPO}.delete_versions", new_callable=AsyncMock),
    ):
        resp = await client.delete(f"{API}/proposal-001")
    assert resp.status_code == 204
    log = only(logs, audit_service.PROPOSAL_DELETED)
    assert_traced(log, action="proposal_deleted")
    assert log["details"]["title"] == "Test Proposal"


@pytest.mark.asyncio
async def test_RNF02_una_accion_rechazada_no_deja_registro_de_exito(client, logs):
    with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=None):
        resp = await client.delete(f"{API}/nonexistent")
    assert resp.status_code == 404
    assert logs == []


# ── Generación en el worker (sin Request) ─────────────────────────────────────

@pytest.mark.asyncio
async def test_RNF02_el_worker_registra_el_resultado_con_la_ip_original(logs):
    options = {
        "userId": FAKE_USER_SUB, "auditIp": "203.0.113.7",
        "versionAuthor": {"author_id": FAKE_USER_SUB, "author_email": FAKE_USER_EMAIL},
    }
    with patch.object(proposal_tasks, "_generate_proposal_now", new_callable=AsyncMock, return_value={"id": "p-1"}):
        await proposal_tasks.generate_proposal_now("job-1", "p-1", "T", "C", "D", options)
    log = only(logs, "proposal_generated")
    assert log["ip"] == "203.0.113.7" and log["userId"] == FAKE_USER_SUB
    assert log["status"] == "success" and log["details"]["stage"] == "completed"


@pytest.mark.asyncio
async def test_RNF02_el_worker_registra_la_generacion_fallida(logs):
    options = {"userId": FAKE_USER_SUB, "auditIp": "203.0.113.7"}
    with patch.object(proposal_tasks, "_generate_proposal_now", new_callable=AsyncMock, side_effect=RuntimeError("LLM caído")):
        with pytest.raises(RuntimeError):
            await proposal_tasks.generate_proposal_now("job-1", "p-1", "T", "C", "D", options)
    log = only(logs, "proposal_generated")
    assert log["status"] == "failed" and "LLM caído" in log["details"]["error"]


# ── Middleware: sin duplicados ni lecturas ────────────────────────────────────

@pytest.mark.asyncio
async def test_RNF02_el_middleware_no_duplica_lo_que_ya_audito_el_router(client, logs):
    with (
        patch(f"{REPO}.create", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(MIDDLEWARE_WRITE_LOG, new_callable=AsyncMock) as middleware_log,
    ):
        await client.post(API, json={"title": "Test Proposal", "clientName": "Acme Corp"})
    assert len(logs) == 1
    middleware_log.assert_not_awaited()


@pytest.mark.asyncio
async def test_RNF02_el_middleware_sigue_registrando_lo_no_cubierto_y_omite_lecturas(client):
    with patch(MIDDLEWARE_WRITE_LOG, new_callable=AsyncMock) as middleware_log:
        with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=None):
            await client.get(f"{API}/nonexistent")          # lectura: no se audita
            middleware_log.assert_not_awaited()
            await client.delete(f"{API}/nonexistent")       # rechazada: red de seguridad HTTP
    log = middleware_log.await_args.args[0]
    assert log["action"] == "deleted_proposal" and log["status"] == "failed" and log["statusCode"] == 404
    assert log["ip"]


def test_RNF02_reglas_de_respaldo_del_middleware():
    from app.middleware.audit import _infer_action

    assert _infer_action("PUT", "/api/v1/proposals/p-1") == "updated_proposal"
    assert _infer_action("POST", "/api/v1/proposals/p-1/send-to-crm") == "sent_proposal_to_crm"
    assert _infer_action("POST", "/api/v1/crm/proposals/p-1/send") == "sent_proposal_to_crm"
    assert _infer_action("POST", "/api/v1/proposals/p-1/versions") == "saved_proposal_version"


# ── IP real ───────────────────────────────────────────────────────────────────

def _request(forwarded: str | None, host: str | None = "10.0.0.5"):
    request = MagicMock()
    request.headers = {"x-forwarded-for": forwarded} if forwarded else {}
    request.client = MagicMock(host=host) if host else None
    return request


def test_RNF02_ip_ignora_x_forwarded_for_si_no_se_confia_en_el_proxy():
    with patch("app.core.client_ip.settings.trust_proxy_headers", False):
        assert get_client_ip(_request("203.0.113.9")) == "10.0.0.5"


def test_RNF02_ip_usa_el_primer_x_forwarded_for_si_se_confia_en_el_proxy():
    with patch("app.core.client_ip.settings.trust_proxy_headers", True):
        assert get_client_ip(_request("203.0.113.9, 10.1.1.1")) == "203.0.113.9"
        assert get_client_ip(_request(None)) == "10.0.0.5"
        assert get_client_ip(_request(None, host=None)) is None


# ── Un fallo al auditar no pasa en silencio ───────────────────────────────────

@pytest.mark.asyncio
async def test_RNF02_un_fallo_al_escribir_el_registro_queda_en_el_log_de_la_app(caplog):
    with patch("app.services.firestore_service.audit_logs_repo.add", new_callable=AsyncMock, side_effect=RuntimeError("firestore caído")):
        with caplog.at_level(logging.ERROR, logger="app.services.audit_service"):
            ok = await audit_service.record(action="proposal_created", resource_id="p-1", user_id="u-1", ip="1.2.3.4")
    assert ok is False
    assert "No se pudo escribir el registro de auditoría" in caplog.text


# ── Consulta del administrador ────────────────────────────────────────────────

def _as(app, role: str):
    previous = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        sub=f"{role}-sub", email=f"{role}@noondalton.com", name=role, roles=[role], raw={"sub": f"{role}-sub"},
    )
    return previous


@pytest_asyncio.fixture
async def role_client(app):
    previous = app.dependency_overrides.get(get_current_user)

    async def make(role: str | None):
        if role is None:
            app.dependency_overrides.pop(get_current_user, None)
        else:
            _as(app, role)
        return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")

    yield make
    if previous is not None:
        app.dependency_overrides[get_current_user] = previous


ADMIN_LOGS = "/api/v1/admin/audit-logs"
SEARCH = "app.routers.admin.audit_logs_repo.search"


@pytest.mark.asyncio
async def test_RNF02_admin_consulta_el_registro(role_client):
    rows = [{"id": "a", "userId": "u-1", "action": "proposal_created", "ip": "1.1.1.1", "timestamp": "2026-11-17T10:00:00+00:00"}]
    async with await role_client("admin") as ac:
        with patch(SEARCH, new_callable=AsyncMock, return_value=(rows, False)) as search:
            resp = await ac.get(ADMIN_LOGS)
    assert resp.status_code == 200
    assert resp.json() == {"logs": rows, "limit": 50, "offset": 0, "hasMore": False}
    assert search.await_args.kwargs["limit"] == 50


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["manager", "user"])
async def test_RNF02_solo_el_administrador_puede_consultar(role_client, role):
    async with await role_client(role) as ac:
        with patch(SEARCH, new_callable=AsyncMock) as search:
            resp = await ac.get(ADMIN_LOGS)
    assert resp.status_code == 403
    search.assert_not_awaited()


@pytest.mark.asyncio
async def test_RNF02_consulta_sin_sesion_no_es_200(role_client):
    async with await role_client(None) as ac:
        resp = await ac.get(ADMIN_LOGS)
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_RNF02_filtros_de_la_consulta(role_client):
    async with await role_client("admin") as ac:
        with patch(SEARCH, new_callable=AsyncMock, return_value=([], True)) as search:
            resp = await ac.get(ADMIN_LOGS, params={
                "userId": "u-1", "action": "proposal_deleted", "resourceId": "p-9",
                "from": "2026-11-01", "to": "2026-11-17", "limit": 20, "offset": 40,
            })
    assert resp.status_code == 200 and resp.json()["hasMore"] is True
    kwargs = search.await_args.kwargs
    assert kwargs["user_id"] == "u-1" and kwargs["action"] == "proposal_deleted" and kwargs["resource_id"] == "p-9"
    assert kwargs["limit"] == 20 and kwargs["offset"] == 40
    assert kwargs["date_from"] == "2026-11-01T00:00:00+00:00"
    assert kwargs["date_to"] == "2026-11-17T23:59:59.999999+00:00"   # 'to' cubre el día completo


@pytest.mark.asyncio
async def test_RNF02_fecha_invalida_es_422(role_client):
    async with await role_client("admin") as ac:
        resp = await ac.get(ADMIN_LOGS, params={"from": "ayer"})
    assert resp.status_code == 422


# ── Repo: búsqueda y paginación ───────────────────────────────────────────────

class _FakeDoc:
    exists = True

    def __init__(self, data):
        self._data = data

    def to_dict(self):
        return self._data


class _FakeQuery:
    """Imita la consulta de Firestore y cuenta los documentos leídos (lo que se cobra).
    `sin_indice=True`: igualdad + orden por otro campo falla como sin índice compuesto."""

    def __init__(self, rows, contador, sin_indice=False, filtros=(), orden=False, salto=0, tope=None):
        self.rows, self.contador, self.sin_indice = rows, contador, sin_indice
        self.filtros, self.orden, self.salto, self.tope = list(filtros), orden, salto, tope

    def _con(self, **cambios):
        datos = dict(rows=self.rows, contador=self.contador, sin_indice=self.sin_indice, filtros=self.filtros, orden=self.orden, salto=self.salto, tope=self.tope)
        datos.update(cambios)
        return _FakeQuery(**datos)

    def where(self, filter):
        return self._con(filtros=[*self.filtros, (filter.field_path, filter.op_string, filter.value)])

    def order_by(self, campo, direction=None):
        return self._con(orden=True)

    def offset(self, n):
        return self._con(salto=n)

    def limit(self, n):
        return self._con(tope=n)

    async def get(self):
        from google.api_core.exceptions import FailedPrecondition

        igualdades = [f for f in self.filtros if f[1] == "=="]
        if self.sin_indice and igualdades and self.orden:
            raise FailedPrecondition("The query requires an index.")
        filas = list(self.rows)
        for campo, op, valor in self.filtros:
            filas = [r for r in filas if (r.get(campo) == valor if op == "==" else
                                          (r.get(campo) or "") >= valor if op == ">=" else (r.get(campo) or "") <= valor)]
        if self.orden:
            filas.sort(key=lambda r: r.get("timestamp") or "", reverse=True)
            leidas = filas[self.salto: self.salto + (self.tope if self.tope is not None else len(filas))]
            self.contador["leidos"] += self.salto and min(self.salto, len(filas)) or 0   # los saltados también se cobran
            self.contador["leidos"] += len(leidas)
            return [_FakeDoc(r) for r in leidas]
        self.contador["leidos"] += len(filas)
        return [_FakeDoc(r) for r in filas]


def _filas_auditoria():
    return [
        {"id": str(i), "userId": "u-1", "action": "proposal_updated", "resourceId": "p-1",
         "timestamp": f"2026-11-1{i}T10:00:00+00:00"}
        for i in range(5)
    ] + [{"id": "x", "userId": "u-2", "action": "proposal_updated", "resourceId": "p-2", "timestamp": "2026-11-19T00:00:00+00:00"}]


@pytest.mark.asyncio
@pytest.mark.parametrize("sin_indice", [False, True])
async def test_RNF02_repo_filtra_ordena_y_pagina(sin_indice):
    """Mismos resultados con los índices compuestos y sin ellos (camino de respaldo)."""
    from app.services.firestore_service import AuditLogsRepo

    contador = {"leidos": 0}
    repo = AuditLogsRepo()
    with patch.object(AuditLogsRepo, "_col", return_value=_FakeQuery(_filas_auditoria(), contador, sin_indice=sin_indice)):
        page, more = await repo.search(user_id="u-1", limit=2)
        assert [r["id"] for r in page] == ["4", "3"] and more is True
        page, more = await repo.search(user_id="u-1", limit=2, offset=4)
        assert [r["id"] for r in page] == ["0"] and more is False
        page, _ = await repo.search(user_id="u-1", date_from="2026-11-12T00:00:00+00:00", date_to="2026-11-13T23:59:59+00:00")
        assert [r["id"] for r in page] == ["3", "2"]
        page, _ = await repo.search(limit=3)   # sin igualdades: orden nativo de timestamp
        assert [r["id"] for r in page] == ["x", "4", "3"]


@pytest.mark.asyncio
async def test_RNF02_con_indice_la_consulta_lee_solo_la_pagina():
    """RNF02-D-001: con el índice compuesto se leen limit + 1 documentos, no todo el conjunto filtrado."""
    from app.services.firestore_service import AuditLogsRepo

    filas = [{"id": str(i), "userId": "u-1", "action": "a", "resourceId": "p", "timestamp": f"2026-10-01T00:{i // 60:02d}:{i % 60:02d}+00:00"} for i in range(1200)]
    contador = {"leidos": 0}
    with patch.object(AuditLogsRepo, "_col", return_value=_FakeQuery(filas, contador)):
        page, more = await AuditLogsRepo().search(user_id="u-1", limit=50)
    assert len(page) == 50 and more is True
    assert contador["leidos"] == 51   # y no 1.200


@pytest.mark.asyncio
async def test_RNF02_sin_indice_avisa_y_sigue_funcionando(caplog):
    from app.services.firestore_service import AuditLogsRepo

    contador = {"leidos": 0}
    with caplog.at_level(logging.WARNING, logger="marketgen.firestore"):
        with patch.object(AuditLogsRepo, "_col", return_value=_FakeQuery(_filas_auditoria(), contador, sin_indice=True)):
            page, _ = await AuditLogsRepo().search(user_id="u-1", limit=2)
    assert [r["id"] for r in page] == ["4", "3"]
    assert "falta un índice compuesto" in caplog.text and "firestore.indexes.json" in caplog.text


def test_RNF02_el_archivo_de_indices_cubre_todas_las_combinaciones_de_filtros():
    import itertools
    import json
    from pathlib import Path

    datos = json.loads((Path(__file__).resolve().parent.parent / "firestore.indexes.json").read_text(encoding="utf-8"))
    tenidos = {tuple(sorted(f["fieldPath"] for f in ix["fields"] if f["fieldPath"] != "timestamp")) for ix in datos["indexes"] if ix["collectionGroup"] == "auditLogs"}
    esperados = {tuple(sorted(c)) for n in (1, 2, 3) for c in itertools.combinations(("userId", "action", "resourceId"), n)}
    assert tenidos == esperados
    assert all(ix["fields"][-1] == {"fieldPath": "timestamp", "order": "DESCENDING"} for ix in datos["indexes"])
