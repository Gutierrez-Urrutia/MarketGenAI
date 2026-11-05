"""RF-VTA-11: historial de versiones de propuestas.

Igual que test_proposal_status.py: no hay un Firestore falso, así que la
transacción de ProposalsRepo.create_version no se ejecuta; el router se prueba con
el repo reemplazado por dobles, y la parte pura (snapshot, hash, versiones
legacy) directamente.
"""
from __future__ import annotations

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
    assert set(snap) == {"title", "content", "structured_content", "total_amount"}
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
