"""RF-VTA-05 paso 2: consumidores de proposal_status (outreach y reports).

Las propuestas se sirven "crudas" desde FirestoreRepo.list (como estarían en
Firestore antes de la migración), así que pasan por la normalización real de
ProposalsRepo.list. Además se prueba reports con proposals_repo.list devolviendo
valores viejos directamente, para cubrir su propia normalización.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services.firestore_service import FirestoreRepo, ProposalsRepo
from tests.conftest import FAKE_USER_SUB

RAW_PROPOSALS = [
    {"id": "p-viejo-neg", "userId": FAKE_USER_SUB, "title": "A", "proposal_status": "En Negociación", "totalAmount": 100},
    {"id": "p-viejo-neg2", "userId": FAKE_USER_SUB, "title": "B", "proposal_status": "en negociacion", "totalAmount": 50},
    {"id": "p-nuevo-neg", "userId": FAKE_USER_SUB, "title": "C", "proposal_status": "en_negociacion", "totalAmount": 10},
    {"id": "p-viejo-cerrada", "userId": FAKE_USER_SUB, "title": "D", "proposal_status": "Cerrada", "totalAmount": 1000},
    {"id": "p-nuevo-firmada", "userId": FAKE_USER_SUB, "title": "E", "proposal_status": "firmada", "totalAmount": 1},
    {"id": "p-viejo-entregada", "userId": FAKE_USER_SUB, "title": "F", "proposal_status": "Entregada"},
    {"id": "p-vista", "userId": FAKE_USER_SUB, "title": "G", "proposal_status": "vista"},
    {"id": "p-perdida", "userId": FAKE_USER_SUB, "title": "H", "proposal_status": "Perdida"},
    {"id": "p-ausente", "userId": FAKE_USER_SUB, "title": "I", "status": "generated"},
    {"id": "p-generada", "userId": FAKE_USER_SUB, "title": "J", "proposal_status": "Generada", "status": "draft"},
    {"id": "p-desconocido", "userId": FAKE_USER_SUB, "title": "K", "proposal_status": "Ganada", "totalAmount": 7},
]


async def _raw_list(self, *args, **kwargs):
    assert isinstance(self, ProposalsRepo), "solo proposals_repo debe leer por FirestoreRepo.list aquí"
    return [dict(p) for p in RAW_PROPOSALS]


# ── outreach: seguimientos de propuestas en negociación ──────────────────────

async def test_followups_pick_negotiation_in_old_and_new_values(client):
    created_payloads = []

    async def _create(payload):
        created_payloads.append(payload)
        return {**payload, "id": f"o-{len(created_payloads)}"}

    with (
        patch.object(FirestoreRepo, "list", autospec=True, side_effect=_raw_list),
        patch("app.routers.outreach._list_for_user", new_callable=AsyncMock, return_value=[]),
        patch("app.routers.outreach._generate_content", new_callable=AsyncMock, return_value="Hola"),
        patch("app.routers.outreach.outreach_repo.create", side_effect=_create),
    ):
        resp = await client.post("/api/v1/outreach/review-queue/proposal-followups", json={"limit": 25})

    assert resp.status_code == 200
    body = resp.json()
    assert body["proposalCount"] == 3
    assert sorted(p["proposal_id"] for p in created_payloads) == ["p-nuevo-neg", "p-viejo-neg", "p-viejo-neg2"]


async def test_followups_ignore_absent_unknown_and_other_states(client):
    with (
        patch("app.routers.outreach.proposals_repo.list", new_callable=AsyncMock, return_value=[
            ProposalsRepo._normalize(dict(p)) for p in RAW_PROPOSALS
            if p["id"] in {"p-ausente", "p-desconocido", "p-vista", "p-nuevo-firmada"}
        ]),
        patch("app.routers.outreach._list_for_user", new_callable=AsyncMock, return_value=[]),
        patch("app.routers.outreach._generate_content", new_callable=AsyncMock) as gen,
        patch("app.routers.outreach.outreach_repo.create", new_callable=AsyncMock) as create,
    ):
        resp = await client.post("/api/v1/outreach/review-queue/proposal-followups", json={})

    assert resp.status_code == 200
    assert resp.json()["proposalCount"] == 0
    gen.assert_not_called()
    create.assert_not_called()


# ── reports ──────────────────────────────────────────────────────────────────

EXPECTED_GROUPS = [
    # (label, count, totalValue) en orden canónico, "desconocido" al final
    ("borrador", 2, 0),          # Generada + ausente
    ("enviada", 1, 0),           # Entregada
    ("vista", 1, 0),
    ("en_negociacion", 3, 160),  # dos viejos + uno nuevo
    ("firmada", 2, 1001),        # Cerrada + firmada
    ("rechazada", 1, 0),         # Perdida
    ("desconocido", 1, 7),       # Ganada
]


@pytest.mark.parametrize("source", ["repo_normalizado", "lista_cruda"])
async def test_reports_proposals_groups_by_code(client, source):
    if source == "repo_normalizado":
        ctx = patch.object(FirestoreRepo, "list", autospec=True, side_effect=_raw_list)
    else:
        ctx = patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock,
                    return_value=[dict(p) for p in RAW_PROPOSALS])
    with ctx:
        resp = await client.get("/api/v1/reports/proposals", params={"limit": 100})

    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"dimension", "data", "timeSeries"}
    assert body["dimension"] == "proposal_status"
    assert [(r["label"], r["count"], r["totalValue"]) for r in body["data"]] == EXPECTED_GROUPS
    assert all(set(r) == {"label", "count", "totalValue"} for r in body["data"])


async def test_reports_proposals_respects_limit(client):
    with patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock,
               return_value=[dict(p) for p in RAW_PROPOSALS]):
        resp = await client.get("/api/v1/reports/proposals", params={"limit": 2})
    assert [r["label"] for r in resp.json()["data"]] == ["borrador", "enviada"]


@pytest.mark.parametrize("source", ["repo_normalizado", "lista_cruda"])
async def test_reports_dashboard_uses_proposal_status(client, source):
    if source == "repo_normalizado":
        ctx = patch.object(FirestoreRepo, "list", autospec=True, side_effect=_raw_list)
    else:
        ctx = patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock,
                    return_value=[dict(p) for p in RAW_PROPOSALS])
    with (
        ctx,
        patch("app.routers.reports.books_repo.count", new_callable=AsyncMock, return_value=0),
        patch("app.routers.reports.proposals_repo.count", new_callable=AsyncMock, return_value=len(RAW_PROPOSALS)),
        patch("app.routers.reports.customers_repo.count", new_callable=AsyncMock, return_value=0),
    ):
        resp = await client.get("/api/v1/reports/dashboard")

    assert resp.status_code == 200
    body = resp.json()
    # enviada 1 + vista 1 + en_negociacion 3 + firmada 2 + rechazada 1; el desconocido no cuenta
    assert body["contacted"] == 8
    assert body["pendingReview"] == 2        # Generada + ausente (el `status` draft/generated ya no influye)
    assert body["replied"] == 5              # en_negociacion 3 + firmada 2
    assert body["won"] == 2                  # Cerrada + firmada
    assert body["totals"]["winRate"] == 25.0
    assert set(body) == {"detected", "researched", "contacted", "pendingReview", "replied", "won", "totals", "generatedAt"}
