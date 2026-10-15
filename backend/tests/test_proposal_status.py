"""RF-VTA-05: estados de propuesta (proposal_status).

La transacción de Firestore en sí (ProposalsRepo.change_status) no tiene prueba
automática: no hay un Firestore falso. Se prueba la decisión pura
(decide_cambio_estado), lo que la transacción escribe (plan_status_change) y el
router con change_status reemplazado por un doble que aplica ese mismo plan.
"""
from __future__ import annotations

import itertools
import logging
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

import app.routers.proposals as proposals_router
from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.proposal import (
    ProposalStatus,
    StatusChangeError,
    decide_cambio_estado,
    normalize_proposal_status,
)
from app.services.firestore_service import FirestoreRepo, ProposalsRepo
from tests.conftest import FAKE_USER_SUB, _fake_current_user

API = "/api/v1/proposals"
REPO = "app.routers.proposals.proposals_repo"
OTHER_USER = "other-user-456"

STATES = ["borrador", "enviada", "vista", "en_negociacion", "firmada", "rechazada"]

# Tabla escrita a mano a partir del requerimiento (no se reutiliza la del código).
ALLOWED = {
    ("borrador", "enviada"),
    ("enviada", "vista"), ("enviada", "en_negociacion"), ("enviada", "rechazada"),
    ("vista", "en_negociacion"), ("vista", "rechazada"),
    ("en_negociacion", "firmada"), ("en_negociacion", "rechazada"),
}
REOPEN = ("rechazada", "en_negociacion")


def fake_proposal(overrides: dict | None = None) -> dict:
    base = {
        "id": "proposal-001",
        "userId": FAKE_USER_SUB,
        "title": "Test Proposal",
        "clientName": "Acme Corp",
        "status": "generated",
        "proposal_status": "borrador",
        "content": "",
        "description": "A proposal for AI services.",
    }
    if overrides:
        base.update(overrides)
    return base


@pytest.fixture
def as_user(app):
    """Reemplaza el usuario de los tests (roles ["nd-user"], fuera de la jerarquía)."""
    def _set(roles: list[str], sub: str = FAKE_USER_SUB):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            sub=sub, email="t@noondalton.com", roles=roles, raw={"sub": sub},
        )
    yield _set
    app.dependency_overrides[get_current_user] = _fake_current_user


class FakeStatusStore:
    """Doble de ProposalsRepo.change_status: aplica el plan real sobre un doc en memoria."""

    def __init__(self, doc: dict | None):
        self.doc = doc
        self.audit_logs: list[dict] = []
        self.calls = 0

    async def change_status(self, proposal_id, target, **kwargs):
        self.calls += 1
        plan = ProposalsRepo.plan_status_change(
            self.doc, target,
            timestamp=datetime.now(timezone.utc).isoformat(),
            audit_id="audit-001",
            **kwargs,
        )
        if "new_status" not in plan:
            return plan
        self.audit_logs.append(plan["audit_log"])
        self.doc = {**self.doc, "proposal_status": plan["new_status"]}
        return {"proposal": self.doc}


# ── decide_cambio_estado: las 36 combinaciones × dueño/admin ─────────────────

@pytest.mark.parametrize("actual,destino", list(itertools.product(STATES, STATES)))
@pytest.mark.parametrize("es_dueno,es_admin", [(True, False), (True, True), (False, False), (False, True)])
def test_decide_all_combinations(actual, destino, es_dueno, es_admin):
    result = decide_cambio_estado(actual, destino, es_dueno, es_admin)
    pair = (actual, destino)

    if not es_dueno:
        if es_admin and pair == REOPEN:
            assert result == ProposalStatus.en_negociacion
        else:
            assert result == StatusChangeError(403, "Access denied.")
        return

    if pair in ALLOWED:
        assert result == ProposalStatus(destino)
    elif pair == REOPEN:
        if es_admin:
            assert result == ProposalStatus.en_negociacion
        else:
            assert isinstance(result, StatusChangeError) and result.status_code == 403
            assert "administrador" in result.detail
    else:
        assert isinstance(result, StatusChangeError) and result.status_code == 409


def test_decide_same_to_same_is_invalid():
    for state in STATES:
        result = decide_cambio_estado(state, state, True, True)
        assert isinstance(result, StatusChangeError) and result.status_code == 409


def test_decide_firmada_is_final_even_for_admin():
    for destino in STATES:
        result = decide_cambio_estado("firmada", destino, True, True)
        assert isinstance(result, StatusChangeError) and result.status_code == 409


@pytest.mark.parametrize("destino", ["Generada", "draft", "", None, "BORRADOR", 3])
@pytest.mark.parametrize("es_dueno,es_admin", [(True, False), (False, True), (False, False)])
def test_decide_invalid_target_is_422(destino, es_dueno, es_admin):
    result = decide_cambio_estado("borrador", destino, es_dueno, es_admin)
    assert isinstance(result, StatusChangeError) and result.status_code == 422


@pytest.mark.parametrize("unknown", ["Ganada", "xyz", 7])
def test_decide_unknown_current_asks_to_migrate(unknown):
    result = decide_cambio_estado(unknown, "enviada", True, False)
    assert isinstance(result, StatusChangeError) and result.status_code == 409
    assert "migrar" in result.detail


@pytest.mark.parametrize("es_admin", [False, True])
def test_decide_unknown_current_on_foreign_proposal_is_403(es_admin):
    result = decide_cambio_estado("Ganada", "en_negociacion", False, es_admin)
    assert result == StatusChangeError(403, "Access denied.")


def test_decide_absent_current_behaves_as_borrador():
    current = normalize_proposal_status(None)
    assert decide_cambio_estado(current, "enviada", True, False) == ProposalStatus.enviada
    assert decide_cambio_estado(current, "vista", True, False).status_code == 409


# ── normalize_proposal_status ────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("Generada", "borrador"), ("generada", "borrador"), ("GENERADA", "borrador"),
    ("Entregada", "enviada"),
    ("En Negociación", "en_negociacion"), ("En negociación", "en_negociacion"),
    ("en negociacion", "en_negociacion"), ("EN NEGOCIACIÓN", "en_negociacion"),
    ("  En  Negociación ", "en_negociacion"),
    ("Cerrada", "firmada"), ("En Contrato", "firmada"), ("en contrato", "firmada"),
    ("Perdida", "rechazada"), ("pérdida", "rechazada"),
    (None, "borrador"),
])
def test_normalize_legacy_values(raw, expected):
    assert normalize_proposal_status(raw) == expected


@pytest.mark.parametrize("code", STATES)
def test_normalize_current_codes_unchanged(code):
    assert normalize_proposal_status(code) == code


@pytest.mark.parametrize("unknown", ["Ganada", "draft", "Borrador", "", 5])
def test_normalize_unknown_left_as_is(unknown):
    assert normalize_proposal_status(unknown) == unknown


def test_repo_normalizes_in_memory_and_warns_on_unknown(caplog):
    with caplog.at_level(logging.WARNING, logger="marketgen.firestore"):
        assert ProposalsRepo._normalize({"id": "p1", "proposal_status": "Entregada"})["proposal_status"] == "enviada"
        assert ProposalsRepo._normalize({"id": "p2"})["proposal_status"] == "borrador"
        assert not caplog.records
        assert ProposalsRepo._normalize({"id": "p3", "proposal_status": "Ganada"})["proposal_status"] == "Ganada"
    assert any("p3" in r.getMessage() for r in caplog.records)


async def test_repo_get_and_list_normalize_without_writing():
    repo = ProposalsRepo()
    stored = {"id": "p1", "proposal_status": "Cerrada"}
    with (
        patch.object(FirestoreRepo, "get", new_callable=AsyncMock, return_value=stored),
        patch.object(FirestoreRepo, "list", new_callable=AsyncMock, return_value=[stored, {"id": "p2"}]),
        patch.object(FirestoreRepo, "update", new_callable=AsyncMock) as update,
    ):
        assert (await repo.get("p1"))["proposal_status"] == "firmada"
        assert [p["proposal_status"] for p in await repo.list(limit=5)] == ["firmada", "borrador"]
    assert stored["proposal_status"] == "Cerrada"  # el dict leído no se modifica
    update.assert_not_called()


# ── plan_status_change: el registro de auditoría ─────────────────────────────

def test_plan_builds_audit_log_with_previous_and_new():
    ts = datetime.now(timezone.utc).isoformat()
    plan = ProposalsRepo.plan_status_change(
        fake_proposal({"proposal_status": "Entregada", "userId": OTHER_USER}),
        "vista",
        actor_id=OTHER_USER, actor_roles=["user"], actor_is_admin=False,
        method="PATCH", path="/api/v1/proposals/proposal-001/status", ip="10.0.0.1",
        timestamp=ts, audit_id="audit-xyz",
    )
    assert plan["new_status"] == "vista"
    assert plan["audit_log"] == {
        "id": "audit-xyz",
        "action": "proposal_status_changed",
        "proposalId": "proposal-001",
        "previousStatus": "enviada",
        "newStatus": "vista",
        "userId": OTHER_USER,
        "roles": ["user"],
        "ownerId": OTHER_USER,
        "method": "PATCH",
        "path": "/api/v1/proposals/proposal-001/status",
        "ip": "10.0.0.1",
        "timestamp": ts,
    }


def test_plan_not_found_and_error_write_nothing():
    kwargs = dict(actor_id=FAKE_USER_SUB, actor_roles=["user"], actor_is_admin=False,
                  method="PATCH", path="/x", ip=None, timestamp="t", audit_id="a")
    assert ProposalsRepo.plan_status_change(None, "enviada", **kwargs) == {"not_found": True}
    plan = ProposalsRepo.plan_status_change(fake_proposal({"proposal_status": "firmada"}), "rechazada", **kwargs)
    assert set(plan) == {"error"} and plan["error"].status_code == 409


# ── Router PATCH /proposals/{id}/status ──────────────────────────────────────

async def _patch_status(client, store, target, get_doc=None):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=get_doc if get_doc is not None else store.doc) as get,
        patch(f"{REPO}.change_status", side_effect=store.change_status),
        patch("app.services.firestore_service.opportunities_repo.get_or_404", new_callable=AsyncMock) as opp_get,
        patch("app.services.firestore_service.opportunities_repo.update", new_callable=AsyncMock) as opp_update,
    ):
        resp = await client.patch(f"{API}/proposal-001/status", json={"status": target})
    return resp, get, opp_get, opp_update


async def test_patch_success_returns_proposal_and_audits(client, as_user):
    as_user(["user"])
    store = FakeStatusStore(fake_proposal({"opportunity_id": "opp-1"}))
    resp, _, opp_get, opp_update = await _patch_status(client, store, "enviada")

    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == "proposal-001" and body["proposal_status"] == "enviada"
    assert body["status"] == "generated"  # el ciclo de generación no se toca
    (log,) = store.audit_logs
    assert (log["previousStatus"], log["newStatus"]) == ("borrador", "enviada")
    assert log["action"] == "proposal_status_changed"
    assert log["userId"] == FAKE_USER_SUB and log["ownerId"] == FAKE_USER_SUB and log["roles"] == ["user"]
    assert log["method"] == "PATCH" and log["path"] == f"{API}/proposal-001/status"
    assert isinstance(log["timestamp"], str) and datetime.fromisoformat(log["timestamp"]).tzinfo is not None
    # El cambio de estado ya no toca el score de la oportunidad.
    opp_get.assert_not_called()
    opp_update.assert_not_called()


def test_score_table_removed():
    assert not hasattr(proposals_router, "PROPOSAL_STATUS_SCORES")
    assert not hasattr(proposals_router, "opportunities_repo")


async def test_patch_invalid_target_is_422_before_reading(client, as_user):
    as_user(["user"])
    store = FakeStatusStore(fake_proposal())
    resp, get, _, _ = await _patch_status(client, store, "Entregada")
    assert resp.status_code == 422
    assert "detail" in resp.json()
    get.assert_not_called()
    assert store.calls == 0


async def test_patch_invalid_transition_is_409(client, as_user):
    as_user(["user"])
    store = FakeStatusStore(fake_proposal({"proposal_status": "firmada"}))
    resp, *_ = await _patch_status(client, store, "rechazada")
    assert resp.status_code == 409
    assert store.audit_logs == []
    assert store.doc["proposal_status"] == "firmada"


async def test_patch_unknown_current_is_409_asking_to_migrate(client, as_user):
    as_user(["user"])
    store = FakeStatusStore(fake_proposal({"proposal_status": "Ganada"}))
    resp, *_ = await _patch_status(client, store, "enviada")
    assert resp.status_code == 409
    assert "migrar" in resp.json()["detail"]


async def test_patch_legacy_current_is_normalized(client, as_user):
    as_user(["user"])
    store = FakeStatusStore(fake_proposal({"proposal_status": "En Negociación"}))
    resp, *_ = await _patch_status(client, store, "firmada")
    assert resp.status_code == 200
    assert store.audit_logs[0]["previousStatus"] == "en_negociacion"


async def test_patch_reopen_without_admin_is_403(client, as_user):
    as_user(["user"])
    store = FakeStatusStore(fake_proposal({"proposal_status": "rechazada"}))
    resp, *_ = await _patch_status(client, store, "en_negociacion")
    assert resp.status_code == 403
    assert "administrador" in resp.json()["detail"]
    assert store.audit_logs == []


async def test_patch_reopen_own_proposal_as_admin(client, as_user):
    as_user(["admin", "user"])
    store = FakeStatusStore(fake_proposal({"proposal_status": "rechazada"}))
    resp, *_ = await _patch_status(client, store, "en_negociacion")
    assert resp.status_code == 200
    assert store.audit_logs[0]["roles"] == ["admin", "user"]


async def test_patch_foreign_proposal_as_non_admin_is_403(client, as_user):
    as_user(["user"])
    store = FakeStatusStore(fake_proposal({"userId": OTHER_USER, "proposal_status": "rechazada"}))
    resp, get, _, _ = await _patch_status(client, store, "en_negociacion")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Access denied."
    get.assert_awaited_once()          # pasa por _get_proposal_for_user, como antes
    assert store.calls == 0


async def test_patch_foreign_proposal_as_admin_only_reopens(client, as_user):
    as_user(["admin", "user"])
    store = FakeStatusStore(fake_proposal({"userId": OTHER_USER, "proposal_status": "rechazada"}))
    resp, get, _, _ = await _patch_status(client, store, "en_negociacion")
    assert resp.status_code == 200
    get.assert_not_called()            # el admin no pasa por _get_proposal_for_user
    log = store.audit_logs[0]
    assert log["userId"] == FAKE_USER_SUB and log["ownerId"] == OTHER_USER

    # Cualquier otra transición sobre una propuesta ajena sigue prohibida.
    store = FakeStatusStore(fake_proposal({"userId": OTHER_USER, "proposal_status": "en_negociacion"}))
    resp, *_ = await _patch_status(client, store, "firmada")
    assert resp.status_code == 403
    assert store.audit_logs == []


async def test_patch_missing_proposal_as_admin_is_404(client, as_user):
    as_user(["admin"])
    store = FakeStatusStore(None)
    resp, *_ = await _patch_status(client, store, "enviada")
    assert resp.status_code == 404


# ── PUT, creación y generate-draft ───────────────────────────────────────────

async def test_put_drops_proposal_status_but_keeps_status(client):
    proposal = fake_proposal()
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=proposal),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=proposal) as update,
    ):
        resp = await client.put(f"{API}/proposal-001", json={
            "title": "Nuevo", "status": "draft", "proposal_status": "firmada",
        })
    assert resp.status_code == 200
    update.assert_awaited_once()
    data = update.await_args.args[1]
    assert "proposal_status" not in data
    assert data["status"] == "draft" and data["title"] == "Nuevo"


async def test_put_with_only_proposal_status_is_ignored_without_error(client):
    proposal = fake_proposal()
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=proposal),
        patch(f"{REPO}.update", new_callable=AsyncMock) as update,
    ):
        resp = await client.put(f"{API}/proposal-001", json={"proposal_status": "firmada"})
    assert resp.status_code == 200
    assert resp.json()["proposal_status"] == "borrador"
    update.assert_not_called()


async def _echo_create(data, doc_id=None):
    return {**data, "id": doc_id or "proposal-new"}


async def test_create_forces_borrador(client):
    with patch(f"{REPO}.create", new_callable=AsyncMock, side_effect=_echo_create) as create:
        resp = await client.post(API, json={"title": "T", "proposal_status": "firmada", "status": "draft"})
    assert resp.status_code == 201
    assert create.await_args.args[0]["proposal_status"] == "borrador"
    assert resp.json()["proposal_status"] == "borrador"
    assert resp.json()["status"] == "draft"


async def test_generate_draft_forces_borrador(client):
    with (
        patch(f"{REPO}.create", new_callable=AsyncMock, side_effect=_echo_create) as create,
        patch("app.routers.proposals.jobs_repo.create_job", new_callable=AsyncMock,
              return_value={"id": "job-1", "status": "pending"}),
        patch("app.routers.proposals.task_generate_proposal.delay"),
    ):
        resp = await client.post(f"{API}/generate-draft", json={
            "title": "T", "description": "d", "proposal_status": "firmada",
        })
    assert resp.status_code == 202
    assert create.await_args.args[0]["proposal_status"] == "borrador"
