"""RF-VTA-11: historial de versiones de propuestas.

Igual que test_proposal_status.py: no hay un Firestore falso, así que la
transacción de ProposalsRepo.create_version no se ejecuta; el router se prueba con
el repo reemplazado por dobles, y la parte pura (snapshot, hash, versiones
legacy) directamente.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from app.services.firestore_service import ProposalsRepo
from tests.conftest import FAKE_USER_SUB

API = "/api/v1/proposals"
REPO = "app.routers.proposals.proposals_repo"
NOW = datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc)


def fake_proposal(overrides: dict | None = None) -> dict:
    base = {
        "id": "proposal-001",
        "userId": FAKE_USER_SUB,
        "title": "Propuesta",
        "proposal_status": "borrador",
        "content": "<p>actual</p>",
    }
    if overrides:
        base.update(overrides)
    return base


def fake_version(number: int = 1, **extra) -> dict:
    return {
        "id": f"v{number}", "proposalId": "proposal-001", "version": number,
        "label": f"Version {number}", "source": "manual", "title": "Propuesta",
        "content": f"<p>contenido {number}</p>", "authorId": FAKE_USER_SUB,
        "authorName": "Test User", "authorEmail": "t@noondalton.com", "createdAt": NOW,
        **extra,
    }


# ── Parte pura del repo ──────────────────────────────────────────────────────

def test_version_snapshot_only_keeps_content_fields():
    snap = ProposalsRepo.version_snapshot(
        fake_proposal({"structured_content": {"a": 1}, "total_amount": 10, "clientName": "X"})
    )
    assert set(snap) == {"title", "content", "structured_content", "total_amount", "totalAmount"}   # totalAmount: RF11-D-008
    assert snap["total_amount"] == 10 and "clientName" not in snap


def test_snapshot_hash_detects_changes_and_ignores_key_order():
    h = ProposalsRepo._snapshot_hash
    assert h({"a": 1, "b": 2}) == h({"b": 2, "a": 1})
    assert h({"content": "x"}) != h({"content": "y"})


def test_legacy_versions_get_id_and_source():
    legacy = ProposalsRepo._legacy_versions([{"version": 1, "content": "c"}, {"content": "d"}])
    assert [v["id"] for v in legacy] == ["legacy-1", "legacy-2"]
    assert all(v["source"] == "manual" for v in legacy)


# ── GET /versions ────────────────────────────────────────────────────────────

async def test_list_versions_returns_author_and_date_without_content(client):
    versions = [fake_version(2), fake_version(1)]
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.list_versions", new_callable=AsyncMock, return_value=versions),
    ):
        resp = await client.get(f"{API}/proposal-001/versions")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2 and [v["version"] for v in body["items"]] == [2, 1]
    first = body["items"][0]
    assert first["authorName"] == "Test User" and first["createdAt"]
    assert "content" not in first


async def test_list_versions_of_other_users_proposal_is_403(client):
    doc = fake_proposal({"userId": "other-user-456"})
    with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=doc):
        resp = await client.get(f"{API}/proposal-001/versions")
    assert resp.status_code == 403


# ── GET /versions/{id} ───────────────────────────────────────────────────────

async def test_get_version_includes_content(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.get_version", new_callable=AsyncMock, return_value=fake_version(1)),
    ):
        resp = await client.get(f"{API}/proposal-001/versions/v1")
    assert resp.status_code == 200
    assert resp.json()["content"] == "<p>contenido 1</p>"


async def test_get_missing_version_is_404(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.get_version", new_callable=AsyncMock, return_value=None),
    ):
        resp = await client.get(f"{API}/proposal-001/versions/nope")
    assert resp.status_code == 404


# ── POST /versions ───────────────────────────────────────────────────────────

async def test_create_version_records_author_and_uses_unsaved_body(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.create_version", new_callable=AsyncMock, return_value=fake_version(1)) as create,
    ):
        resp = await client.post(f"{API}/proposal-001/versions", json={"content": "<p>borrador</p>", "label": "Hito"})
    assert resp.status_code == 200
    args, kwargs = create.await_args
    assert args[1]["content"] == "<p>borrador</p>" and args[1]["title"] == "Propuesta"
    assert kwargs["author_id"] == FAKE_USER_SUB
    assert kwargs["author_name"] == "Test User"
    assert kwargs["source"] == "manual" and kwargs["label"] == "Hito"


async def test_create_version_without_body_snapshots_current_state(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.create_version", new_callable=AsyncMock, return_value=fake_version(1)) as create,
    ):
        resp = await client.post(f"{API}/proposal-001/versions", json={})
    assert resp.status_code == 200
    assert create.await_args.args[1]["content"] == "<p>actual</p>"


# ── POST /versions/{id}/restore ──────────────────────────────────────────────

async def test_restore_snapshots_current_then_applies_and_records_restore(client):
    current = fake_proposal()
    restored = {**current, "content": "<p>contenido 1</p>"}
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=current),
        patch(f"{REPO}.get_version", new_callable=AsyncMock, return_value=fake_version(1)),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=restored) as update,
        patch(f"{REPO}.create_version", new_callable=AsyncMock, return_value=fake_version(3)) as create,
    ):
        resp = await client.post(f"{API}/proposal-001/versions/v1/restore")
    assert resp.status_code == 200
    assert resp.json()["content"] == "<p>contenido 1</p>"
    assert update.await_args.args[1]["content"] == "<p>contenido 1</p>"
    first, second = create.await_args_list
    assert first.args[1]["content"] == "<p>actual</p>"
    assert first.kwargs["skip_if_unchanged"] is True and first.kwargs["source"] == "auto"
    assert second.kwargs["source"] == "restore" and second.kwargs["label"] == "Restored from v1"


async def test_restore_on_firmada_is_409(client):
    doc = fake_proposal({"proposal_status": "firmada"})
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=doc),
        patch(f"{REPO}.update", new_callable=AsyncMock) as update,
    ):
        resp = await client.post(f"{API}/proposal-001/versions/v1/restore")
    assert resp.status_code == 409
    update.assert_not_called()


async def test_restore_missing_version_is_404(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.get_version", new_callable=AsyncMock, return_value=None),
        patch(f"{REPO}.update", new_callable=AsyncMock) as update,
    ):
        resp = await client.post(f"{API}/proposal-001/versions/nope/restore")
    assert resp.status_code == 404
    update.assert_not_called()


# ── Snapshot automático en PUT ───────────────────────────────────────────────

async def test_put_content_change_creates_initial_and_new_auto_versions(client):
    before = fake_proposal()
    after = {**before, "content": "<p>nuevo</p>"}
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=before),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=after),
        patch(f"{REPO}.create_version", new_callable=AsyncMock) as create,
    ):
        resp = await client.put(f"{API}/proposal-001", json={"content": "<p>nuevo</p>"})
    assert resp.status_code == 200
    first, second = create.await_args_list
    assert first.args[1]["content"] == "<p>actual</p>" and first.kwargs["label"] == "Initial"
    assert second.args[1]["content"] == "<p>nuevo</p>" and second.kwargs["source"] == "auto"
    assert second.kwargs["skip_if_unchanged"] is True


async def test_put_with_existing_history_only_snapshots_new_state(client):
    before = fake_proposal({"versionCounter": 2})
    after = {**before, "title": "Otro"}
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=before),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=after),
        patch(f"{REPO}.create_version", new_callable=AsyncMock) as create,
    ):
        resp = await client.put(f"{API}/proposal-001", json={"title": "Otro"})
    assert resp.status_code == 200
    create.assert_awaited_once()
    assert create.await_args.args[1]["title"] == "Otro"


async def test_put_without_content_fields_creates_no_version(client):
    before = fake_proposal()
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=before),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value={**before, "clientName": "X"}),
        patch(f"{REPO}.create_version", new_callable=AsyncMock) as create,
    ):
        resp = await client.put(f"{API}/proposal-001", json={"clientName": "X"})
    assert resp.status_code == 200
    create.assert_not_called()


async def test_put_succeeds_even_if_auto_snapshot_fails(client):
    before = fake_proposal()
    after = {**before, "content": "<p>nuevo</p>"}
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=before),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=after),
        patch(f"{REPO}.create_version", new_callable=AsyncMock, side_effect=RuntimeError("firestore down")),
    ):
        resp = await client.put(f"{API}/proposal-001", json={"content": "<p>nuevo</p>"})
    assert resp.status_code == 200
    assert resp.json()["content"] == "<p>nuevo</p>"


# ── RF-VTA-11 (cierre): correcciones RF11-D-001 a RF11-D-009 ─────────────────

def test_restore_fields_clear_what_the_version_had_empty_and_skip_what_it_does_not_have():
    """RF11-D-003: una versión que guardó la estructura o el monto vacíos los vacía al restaurar;
    una versión del formato anterior (sin esas claves) no las toca."""
    nueva = {"title": "T", "content": "c", "structured_content": None, "total_amount": None, "totalAmount": None}
    assert ProposalsRepo.version_restore_fields(nueva) == nueva
    antigua = {"version": 1, "title": "T", "content": "c"}
    assert ProposalsRepo.version_restore_fields(antigua) == {"title": "T", "content": "c"}


def test_total_amount_in_both_spellings_is_part_of_the_snapshot():
    """RF11-D-008: el producto lee el monto como total_amount o totalAmount; las dos viajan en la versión."""
    snap = ProposalsRepo.version_snapshot(fake_proposal({"totalAmount": 3000}))
    assert snap["totalAmount"] == 3000 and "total_amount" in snap


async def test_restore_puts_none_fields_back_to_empty(client):
    current = fake_proposal({"structured_content": {"a": 1}, "total_amount": 999})
    version = fake_version(1, structured_content=None, total_amount=None, totalAmount=None)
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=current),
        patch(f"{REPO}.get_version", new_callable=AsyncMock, return_value=version),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=current) as update,
        patch(f"{REPO}.create_version", new_callable=AsyncMock),
    ):
        resp = await client.post(f"{API}/proposal-001/versions/v1/restore")
    assert resp.status_code == 200
    fields = update.await_args.args[1]
    assert fields["structured_content"] is None and fields["total_amount"] is None


async def test_list_versions_keeps_the_legacy_ones_after_new_versions_exist():
    """RF11-D-001: al guardar la primera versión nueva las antiguas (embebidas) no desaparecen del listado."""
    nueva = {"id": "n3", "version": 3, "label": "Nueva", "source": "manual"}

    class _Doc:
        exists = True

        def to_dict(self):
            return nueva

    class _Col:
        def order_by(self, *a, **k):
            return self

        async def get(self):
            return [_Doc()]

    repo = ProposalsRepo()
    legacy = [{"version": 1, "content": "a"}, {"version": 2, "content": "b"}]
    with patch.object(ProposalsRepo, "_versions_col", return_value=_Col()):
        items = await repo.list_versions("proposal-001", legacy)
    assert [i["version"] for i in items] == [3, 2, 1]
    assert [i["id"] for i in items] == ["n3", "legacy-2", "legacy-1"]


def test_legacy_versions_ignore_garbage():
    assert ProposalsRepo._legacy_versions("texto") == []
    assert ProposalsRepo._legacy_versions([None, 5, {"version": 2, "content": "x"}])[0]["id"] == "legacy-2"


async def test_create_version_label_has_a_maximum_length(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.create_version", new_callable=AsyncMock, return_value=fake_version(1)) as create,
    ):
        ok = await client.post(f"{API}/proposal-001/versions", json={"label": "L" * 200})
        largo = await client.post(f"{API}/proposal-001/versions", json={"label": "L" * 201})
    assert ok.status_code == 200
    assert largo.status_code == 422
    assert create.await_count == 1


async def test_saving_versions_is_limited_to_20_per_minute(client):
    codes = []
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.create_version", new_callable=AsyncMock, return_value=fake_version(1)),
    ):
        for _ in range(22):
            codes.append((await client.post(f"{API}/proposal-001/versions", json={})).status_code)
    assert codes[:20] == [200] * 20 and codes[20:] == [429, 429]


async def test_restoring_is_limited_to_20_per_minute(client):
    codes = []
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.get_version", new_callable=AsyncMock, return_value=fake_version(1)),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.create_version", new_callable=AsyncMock),
    ):
        for _ in range(22):
            codes.append((await client.post(f"{API}/proposal-001/versions/v1/restore")).status_code)
    assert codes[:20] == [200] * 20 and codes[20:] == [429, 429]


async def test_put_ignores_the_internal_history_marks(client):
    """RF11-D-009: el cliente no puede escribir versions, versionCounter ni versionHash."""
    before = fake_proposal()
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=before),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=before) as update,
        patch(f"{REPO}.create_version", new_callable=AsyncMock),
    ):
        resp = await client.put(
            f"{API}/proposal-001",
            json={"clientName": "X", "versions": [{"version": 7}], "versionCounter": 500, "versionHash": "x"},
        )
    assert resp.status_code == 200
    assert update.await_args.args[1] == {"clientName": "X"}


async def test_create_proposal_ignores_the_internal_history_marks(client):
    async def _create(data, doc_id=None):
        return {**data, "id": doc_id}

    with patch(f"{REPO}.create", new_callable=AsyncMock, side_effect=_create) as create:
        resp = await client.post(API, json={"title": "T", "versions": [{"version": 7}], "versionCounter": 999, "versionHash": "x"})
    assert resp.status_code == 201
    data = create.await_args.args[0]
    assert "versions" not in data and "versionCounter" not in data and "versionHash" not in data


async def test_deleting_a_proposal_deletes_its_versions(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.delete", new_callable=AsyncMock) as delete,
        patch(f"{REPO}.delete_versions", new_callable=AsyncMock, return_value=3) as delete_versions,
    ):
        resp = await client.delete(f"{API}/proposal-001")
    assert resp.status_code == 204
    delete.assert_awaited_once_with("proposal-001")
    delete_versions.assert_awaited_once_with("proposal-001")


async def test_deleting_a_proposal_succeeds_even_if_deleting_versions_fails(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.delete", new_callable=AsyncMock),
        patch(f"{REPO}.delete_versions", new_callable=AsyncMock, side_effect=RuntimeError("firestore down")),
    ):
        resp = await client.delete(f"{API}/proposal-001")
    assert resp.status_code == 204


def test_audit_labels_for_saving_and_restoring_versions():
    """RF11-D-005: antes las dos caían en «created_proposal»."""
    from app.middleware.audit import _infer_action

    assert _infer_action("POST", "/api/v1/proposals/p1/versions") == "saved_proposal_version"
    assert _infer_action("POST", "/api/v1/proposals/p1/versions/v1/restore") == "restored_proposal_version"
    assert _infer_action("POST", "/api/v1/proposals") == "created_proposal"
    assert _infer_action("DELETE", "/api/v1/proposals/p1") == "deleted_proposal"


# ── Regenerar con IA deja el contenido anterior en el historial (RF11-D-002) ──

def _generation_patches(pt, previo, nuevo, create_version_kwargs=None):
    return (
        patch.object(pt.jobs_repo, "update_progress", new_callable=AsyncMock),
        patch.object(pt.jobs_repo, "complete_job", new_callable=AsyncMock),
        patch.object(pt, "_generate_proposal_content", new_callable=AsyncMock,
                     return_value={"content": "<p>GENERADO</p>", "downloadUrl": None, "filePath": None}),
        patch.object(pt.proposals_repo, "get", new_callable=AsyncMock, side_effect=[previo, nuevo]),
        patch.object(pt.proposals_repo, "update", new_callable=AsyncMock, return_value=nuevo),
        patch.object(pt.proposals_repo, "create_version", new_callable=AsyncMock, **(create_version_kwargs or {})),
    )


async def test_regenerating_saves_the_previous_content_and_the_new_one():
    from app.workers.tasks import proposal_tasks as pt

    previo = fake_proposal({"content": "<p>ESCRITO A MANO</p>"})
    nuevo = {**previo, "content": "<p>GENERADO</p>"}
    author = {"author_id": FAKE_USER_SUB, "author_name": "Test User", "author_email": "t@noondalton.com"}
    p1, p2, p3, p4, p5, p6 = _generation_patches(pt, previo, nuevo)
    with p1, p2, p3, p4, p5, p6 as create:
        await pt.generate_proposal_now("job-1", "proposal-001", "T", "C", "D", {"versionAuthor": author, "userId": FAKE_USER_SUB})
    antes, despues = create.await_args_list
    assert antes.args[1]["content"] == "<p>ESCRITO A MANO</p>" and antes.kwargs["label"] == "Before regeneration"
    assert despues.args[1]["content"] == "<p>GENERADO</p>" and despues.kwargs["label"] == "Generated"
    assert antes.kwargs["author_id"] == FAKE_USER_SUB and antes.kwargs["source"] == "auto"


async def test_generating_a_new_empty_proposal_only_saves_the_generated_version():
    from app.workers.tasks import proposal_tasks as pt

    vacia = fake_proposal({"content": ""})
    nueva = {**vacia, "content": "<p>GENERADO</p>"}
    p1, p2, p3, p4, p5, p6 = _generation_patches(pt, vacia, nueva)
    with p1, p2, p3, p4, p5, p6 as create:
        await pt.generate_proposal_now("job-1", "proposal-001", "T", "C", "D", {"userId": FAKE_USER_SUB})
    create.assert_awaited_once()
    assert create.await_args.kwargs["label"] == "Generated"
    assert create.await_args.kwargs["author_id"] == FAKE_USER_SUB


async def test_generation_succeeds_even_if_saving_the_version_fails():
    from app.workers.tasks import proposal_tasks as pt

    previo = fake_proposal({"content": "<p>algo</p>"})
    nuevo = {**previo, "content": "<p>GENERADO</p>"}
    p1, p2, p3, p4, p5, p6 = _generation_patches(pt, previo, nuevo, {"side_effect": RuntimeError("firestore down")})
    with p1, p2, p3, p4, p5, p6:
        result = await pt.generate_proposal_now("job-1", "proposal-001", "T", "C", "D", {"userId": FAKE_USER_SUB})
    assert result["content"] == "<p>GENERADO</p>"


# ── Guardados simultáneos y contenido que no cabe (RF11-D-011 y RF11-D-012) ──

async def test_create_version_retries_when_firestore_aborts_the_transaction():
    """RF11-D-011: con Firestore real, 10 guardados a la vez daban «Failed to commit transaction in 5 attempts»."""
    repo = ProposalsRepo()
    llamadas = []

    async def _una_vez(proposal_id, snapshot, **kwargs):
        llamadas.append(1)
        if len(llamadas) < 3:
            raise ValueError("Failed to commit transaction in 5 attempts.")
        return {"id": "v1", "version": 1}

    with patch.object(ProposalsRepo, "_create_version_once", side_effect=_una_vez), patch("asyncio.sleep", new_callable=AsyncMock):
        version = await repo.create_version("proposal-001", {"content": "x"}, author_id="u", author_name=None, author_email=None)
    assert version["version"] == 1 and len(llamadas) == 3


async def test_create_version_gives_up_after_the_attempts_and_other_errors_are_not_retried():
    repo = ProposalsRepo()
    with patch.object(ProposalsRepo, "_create_version_once", new_callable=AsyncMock, side_effect=ValueError("Failed to commit transaction in 5 attempts.")) as una, patch("asyncio.sleep", new_callable=AsyncMock):
        try:
            await repo.create_version("proposal-001", {}, author_id="u", author_name=None, author_email=None)
        except ValueError:
            pass
        else:
            raise AssertionError("debía propagar el error")
    assert una.await_count == ProposalsRepo.VERSION_TXN_ATTEMPTS
    with patch.object(ProposalsRepo, "_create_version_once", new_callable=AsyncMock, side_effect=ValueError("otro error")) as una:
        try:
            await repo.create_version("proposal-001", {}, author_id="u", author_name=None, author_email=None)
        except ValueError:
            pass
    assert una.await_count == 1


async def test_create_version_serializes_concurrent_saves_of_the_same_proposal():
    repo = ProposalsRepo()
    activas, maximo = [0], [0]

    async def _una_vez(proposal_id, snapshot, **kwargs):
        activas[0] += 1
        maximo[0] = max(maximo[0], activas[0])
        await asyncio.sleep(0.01)
        activas[0] -= 1
        return {"id": "v", "version": 1}

    with patch.object(ProposalsRepo, "_create_version_once", side_effect=_una_vez):
        await asyncio.gather(*[repo.create_version("proposal-001", {}, author_id="u", author_name=None, author_email=None) for _ in range(8)])
    assert maximo[0] == 1


async def test_saving_a_version_answers_503_when_the_transaction_keeps_aborting(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.create_version", new_callable=AsyncMock, side_effect=ValueError("Failed to commit transaction in 5 attempts.")),
    ):
        resp = await client.post(f"{API}/proposal-001/versions", json={})
    assert resp.status_code == 503
    assert resp.headers.get("retry-after") == "1"
    assert "Inténtalo de nuevo" in resp.json()["detail"]


async def test_restore_does_not_touch_the_proposal_if_the_current_state_could_not_be_saved(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.get_version", new_callable=AsyncMock, return_value=fake_version(1)),
        patch(f"{REPO}.update", new_callable=AsyncMock) as update,
        patch(f"{REPO}.create_version", new_callable=AsyncMock, side_effect=ValueError("Failed to commit transaction in 5 attempts.")),
    ):
        resp = await client.post(f"{API}/proposal-001/versions/v1/restore")
    assert resp.status_code == 503
    update.assert_not_called()


async def test_restore_succeeds_even_if_recording_the_restoration_fails(client):
    current = fake_proposal()
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=current),
        patch(f"{REPO}.get_version", new_callable=AsyncMock, return_value=fake_version(1)),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value={**current, "content": "<p>contenido 1</p>"}),
        patch(f"{REPO}.create_version", new_callable=AsyncMock, side_effect=[None, RuntimeError("firestore down")]),
    ):
        resp = await client.post(f"{API}/proposal-001/versions/v1/restore")
    assert resp.status_code == 200


async def test_a_version_that_does_not_fit_in_firestore_is_rejected_with_413(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.create_version", new_callable=AsyncMock, return_value=fake_version(1)) as create,
    ):
        resp = await client.post(f"{API}/proposal-001/versions", json={"content": "X" * 1_200_000})
        ok = await client.post(f"{API}/proposal-001/versions", json={"content": "X" * 900_000})
    assert resp.status_code == 413
    assert "demasiado grande" in resp.json()["detail"]
    assert ok.status_code == 200
    assert create.await_count == 1   # la de 1,2 MB ni siquiera llegó a Firestore
