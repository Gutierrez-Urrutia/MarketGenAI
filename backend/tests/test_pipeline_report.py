"""RF-VTA-10 — reporte de pipeline: cálculo, endpoint y exportación (xlsx, csv, pdf)."""
from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

import openpyxl
import pytest

from app.services import pipeline_report_service as svc
from app.services.firestore_service import ProposalsRepo
from tests.conftest import FAKE_USER_SUB

NOW = datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)


def day(offset: int) -> datetime:
    return NOW - timedelta(days=offset)


def proposal(status="borrador", amount=1000, cur="USD", created=30, signed=None, **extra):
    doc = {
        "id": f"p-{status}-{amount}-{created}", "userId": FAKE_USER_SUB, "title": f"Propuesta {status}",
        "clientName": "ACME", "proposal_status": status, "totalAmount": amount, "currency": cur,
        "createdAt": day(created),
    }
    if signed is not None:
        doc["statusDates"] = {"firmada": day(signed)}
    doc.update(extra)
    return doc


def sample():
    return [
        proposal("borrador", 500, created=2),
        proposal("enviada", 1000, created=10),
        proposal("vista", 2000, created=12),
        proposal("en_negociacion", 3000, created=20),
        proposal("firmada", 10000, created=40, signed=30),   # 10 días
        proposal("firmada", 4000, created=30, signed=10),    # 20 días
        proposal("rechazada", 700, created=50),
        proposal("firmada", 8_000_000, "CLP", created=60, signed=45),  # 15 días
    ]


class TestReportNumbers:
    def test_counts_by_status_and_sent(self):
        report = svc.build_pipeline_report(sample(), now=NOW)
        counts = {r["status"]: r["count"] for r in report["byStatus"]}
        assert counts == {"borrador": 1, "enviada": 1, "vista": 1, "en_negociacion": 1, "firmada": 3, "rechazada": 1}
        assert report["totals"]["proposals"] == 8
        assert report["totals"]["sent"] == 7          # todo lo que salió de borrador

    def test_status_rows_follow_the_lifecycle_order(self):
        report = svc.build_pipeline_report(sample(), now=NOW)
        assert [r["status"] for r in report["byStatus"]] == [
            "borrador", "enviada", "vista", "en_negociacion", "firmada", "rechazada"]

    def test_conversion_and_win_rate(self):
        report = svc.build_pipeline_report(sample(), now=NOW)
        assert report["conversionRate"] == round(3 / 7 * 100, 1)       # firmadas ÷ enviadas
        assert report["winRate"] == 75.0                               # 3 firmadas ÷ (3 + 1 rechazada)

    def test_rates_are_none_without_data_not_zero(self):
        report = svc.build_pipeline_report([proposal("borrador")], now=NOW)
        assert report["conversionRate"] is None and report["winRate"] is None

    def test_value_is_never_mixed_across_currencies(self):
        report = svc.build_pipeline_report(sample(), now=NOW)
        assert report["value"]["total"] == {"USD": 21200.0, "CLP": 8_000_000.0}
        assert report["value"]["won"] == {"USD": 14000.0, "CLP": 8_000_000.0}
        assert report["value"]["open"] == {"USD": 6000.0, "CLP": 0.0}  # enviada + vista + en negociación

    def test_proposals_without_currency_count_as_usd(self):
        legacy = proposal("enviada", 900)
        del legacy["currency"]
        report = svc.build_pipeline_report([legacy], now=NOW)
        assert report["value"]["total"]["USD"] == 900.0

    def test_amount_is_read_from_every_spelling(self):
        items = [
            {"proposal_status": "enviada", "total_amount": 100, "createdAt": day(1)},
            {"proposal_status": "enviada", "structured_content": {"totalAmount": 50}, "createdAt": day(1)},
            {"proposal_status": "enviada", "total": "25", "createdAt": day(1)},
        ]
        assert svc.build_pipeline_report(items, now=NOW)["value"]["total"]["USD"] == 175.0

    def test_unrecognised_status_is_grouped_as_unknown_and_not_sent(self):
        report = svc.build_pipeline_report([proposal("???"), proposal("enviada")], now=NOW)
        counts = {r["status"]: r["count"] for r in report["byStatus"]}
        assert counts["desconocido"] == 1
        assert report["totals"]["sent"] == 1

    def test_legacy_status_names_are_normalised(self):
        report = svc.build_pipeline_report([proposal("cerrada"), proposal("perdida")], now=NOW)
        assert report["totals"]["signed"] == 1 and report["totals"]["rejected"] == 1

    def test_empty_report(self):
        report = svc.build_pipeline_report([], now=NOW)
        assert report["byStatus"] == [] and report["totals"]["proposals"] == 0
        assert report["closeTime"]["averageDays"] is None


class TestCloseTime:
    def test_average_days_between_creation_and_signature(self):
        report = svc.build_pipeline_report(sample(), now=NOW)
        assert report["closeTime"] == {"averageDays": 15.0, "signedWithDate": 3, "signedWithoutDate": 0}

    def test_signed_without_a_close_date_is_counted_but_not_averaged(self):
        items = sample() + [proposal("firmada", 100, created=5)]      # firmada sin statusDates
        close = svc.build_pipeline_report(items, now=NOW)["closeTime"]
        assert close["averageDays"] == 15.0
        assert close["signedWithDate"] == 3 and close["signedWithoutDate"] == 1

    def test_incoherent_dates_are_not_averaged(self):
        bad = proposal("firmada", 100, created=5, signed=10)          # firmada antes de crearse
        close = svc.build_pipeline_report([bad], now=NOW)["closeTime"]
        assert close["averageDays"] is None and close["signedWithoutDate"] == 1

    def test_dates_as_iso_strings_are_accepted(self):
        item = proposal("firmada", 100, created=10)
        item["createdAt"] = day(10).isoformat()
        item["statusDates"] = {"firmada": day(4).isoformat().replace("+00:00", "Z")}
        assert svc.build_pipeline_report([item], now=NOW)["closeTime"]["averageDays"] == 6.0

    def test_only_signed_proposals_enter_the_average(self):
        item = proposal("rechazada", 100, created=10)
        item["statusDates"] = {"firmada": day(1)}
        assert svc.build_pipeline_report([item], now=NOW)["closeTime"]["averageDays"] is None


class TestPeriod:
    def test_days_filters_by_creation_date(self):
        report = svc.build_pipeline_report(sample(), days=30, now=NOW)
        assert report["totals"]["proposals"] == 5            # creadas hace 2, 10, 12, 20 y 30 días
        assert report["period"]["days"] == 30

    def test_no_days_means_the_whole_history(self):
        assert svc.build_pipeline_report(sample(), now=NOW)["period"]["days"] is None

    def test_proposal_without_creation_date_is_left_out_of_a_period(self):
        item = proposal("enviada")
        del item["createdAt"]
        assert svc.build_pipeline_report([item], days=30, now=NOW)["totals"]["proposals"] == 0
        assert svc.build_pipeline_report([item], now=NOW)["totals"]["proposals"] == 1


class TestStatusDatesWritten:
    """La transacción de change_status guarda la fecha del cambio: de ahí sale el tiempo de cierre."""

    @pytest.mark.asyncio
    async def test_change_status_stamps_status_dates(self):
        repo = ProposalsRepo.__new__(ProposalsRepo)
        existing = {"id": "p1", "userId": "u1", "proposal_status": "en_negociacion", "signedDocumentPath": "x.pdf"}
        snap = MagicMock(exists=True)
        snap.to_dict.return_value = existing
        ref = MagicMock()
        ref.get = AsyncMock(return_value=snap)
        txn = MagicMock()
        repo._doc = lambda _id: ref
        repo.audit_collection = "audit"
        db = MagicMock()
        db.collection.return_value.document.return_value = MagicMock()
        db.transaction.return_value = txn

        with patch.object(ProposalsRepo, "db", new_callable=PropertyMock, return_value=db),                 patch("app.services.firestore_service.firestore.async_transactional", lambda fn: fn):
            outcome = await repo.change_status(
                "p1", "firmada", actor_id="u1", actor_roles=["user"], actor_is_admin=False,
                method="PATCH", path="/p1/status", ip=None,
            )

        update = txn.update.call_args[0][1]
        assert update["proposal_status"] == "firmada"
        assert update["statusDates.firmada"] == update["updatedAt"]
        assert "firmada" in outcome["proposal"]["statusDates"]

    def test_client_cannot_write_status_dates(self):
        from app.schemas.proposal import strip_server_only_fields
        data = strip_server_only_fields({"title": "x", "statusDates": {"firmada": "2020-01-01"}})
        assert "statusDates" not in data


class TestEndpoints:
    @pytest.mark.asyncio
    async def test_pipeline_endpoint_returns_the_report(self, client):
        with patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock, return_value=sample()) as listing:
            resp = await client.get("/api/v1/reports/pipeline")
        assert resp.status_code == 200
        body = resp.json()
        assert body["totals"]["signed"] == 3 and body["winRate"] == 75.0
        assert body["closeTime"]["averageDays"] == 15.0
        assert ("userId", "==", FAKE_USER_SUB) in listing.call_args.kwargs["filters"]

    @pytest.mark.asyncio
    async def test_pipeline_endpoint_period(self, client):
        with patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock, return_value=sample()):
            resp = await client.get("/api/v1/reports/pipeline?days=30")
        assert resp.status_code == 200 and resp.json()["period"]["days"] == 30

    @pytest.mark.asyncio
    @pytest.mark.parametrize("days", ["0", "-5", "abc", "99999"])
    async def test_pipeline_endpoint_rejects_invalid_period(self, client, days):
        resp = await client.get(f"/api/v1/reports/pipeline?days={days}")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_pipeline_endpoint_flags_truncation(self, client):
        many = [proposal("enviada", 1, created=1) for _ in range(svc.MAX_PROPOSALS)]
        with patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock, return_value=many):
            resp = await client.get("/api/v1/reports/pipeline")
        assert resp.json()["truncated"] is True

    @pytest.mark.asyncio
    async def test_export_xlsx_has_sales_data(self, client):
        with patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock, return_value=sample()):
            resp = await client.get("/api/v1/reports/export?format=xlsx&report=pipeline")
        assert resp.status_code == 200
        assert "spreadsheetml" in resp.headers["content-type"]
        wb = openpyxl.load_workbook(io.BytesIO(resp.content))
        assert wb.sheetnames == ["Resumen", "Por estado", "Propuestas"]
        summary = {row[0].value: row[1].value for row in wb["Resumen"].iter_rows(min_row=2)}
        assert summary["Firmadas"] == "3"
        assert summary["Win rate (firmadas ÷ cerradas)"] == "75.0 %"
        assert summary["Tiempo promedio de cierre"] == "15.0 días"
        assert "USD 21,200" in summary["Valor total"] and "CLP 8,000,000" in summary["Valor total"]
        assert wb["Propuestas"].max_row == 1 + len(sample())
        by_status = {row[0].value: row[1].value for row in wb["Por estado"].iter_rows(min_row=2)}
        assert by_status["Firmada"] == 3

    @pytest.mark.asyncio
    async def test_export_csv_one_row_per_proposal(self, client):
        with patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock, return_value=sample()):
            resp = await client.get("/api/v1/reports/export?format=csv&report=pipeline")
        assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/csv")
        assert resp.content.startswith(b"\xef\xbb\xbf")               # BOM: Excel respeta las tildes
        rows = list(csv.reader(io.StringIO(resp.content.decode("utf-8-sig"))))
        assert rows[0] == svc.DETAIL_HEADERS
        assert len(rows) == 1 + len(sample())
        signed = [r for r in rows[1:] if r[2] == "Firmada" and r[4] == "CLP"][0]
        assert signed[3] == "8000000.0" and signed[7] == "15.0"

    @pytest.mark.asyncio
    async def test_export_pdf_is_a_real_pdf(self, client):
        with patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock, return_value=sample()):
            resp = await client.get("/api/v1/reports/export?format=pdf&report=pipeline")
        assert resp.status_code == 200 and resp.headers["content-type"] == "application/pdf"
        assert resp.content.startswith(b"%PDF") and len(resp.content) > 2000

    @pytest.mark.asyncio
    @pytest.mark.parametrize("fmt", ["xlsx", "csv", "pdf"])
    async def test_export_with_no_proposals_still_produces_a_file(self, client, fmt):
        with patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock, return_value=[]):
            resp = await client.get(f"/api/v1/reports/export?format={fmt}&report=pipeline")
        assert resp.status_code == 200 and len(resp.content) > 0

    @pytest.mark.asyncio
    async def test_export_respects_the_period(self, client):
        real_now = datetime.now(timezone.utc)
        items = [
            proposal("enviada", 1, created=0, createdAt=real_now - timedelta(days=5)),
            proposal("enviada", 2, created=0, createdAt=real_now - timedelta(days=200)),
        ]
        with patch("app.routers.reports.proposals_repo.list", new_callable=AsyncMock, return_value=items):
            resp = await client.get("/api/v1/reports/export?format=csv&report=pipeline&days=30")
        rows = list(csv.reader(io.StringIO(resp.content.decode("utf-8-sig"))))
        assert len(rows) == 2 and rows[1][3] == "1.0"

    @pytest.mark.asyncio
    async def test_export_rejects_unknown_report_or_format(self, client):
        assert (await client.get("/api/v1/reports/export?report=otro")).status_code == 422
        assert (await client.get("/api/v1/reports/export?format=docx&report=pipeline")).status_code == 422

    @pytest.mark.asyncio
    async def test_default_export_is_still_the_books_report(self, client):
        with patch("app.routers.reports.books_repo.list", new_callable=AsyncMock, return_value=[]):
            resp = await client.get("/api/v1/reports/export?format=csv")
        assert resp.status_code == 200


class TestBackfillPlan:
    """scripts/migrations/backfill_status_dates: toma de la auditoría la fecha de los cambios ya hechos."""

    def test_copies_the_latest_change_per_status(self):
        from scripts.migrations.backfill_status_dates import plan_updates
        logs = [
            {"newStatus": "enviada", "timestamp": "2026-01-02T10:00:00+00:00"},
            {"newStatus": "en_negociacion", "timestamp": "2026-01-03T10:00:00+00:00"},
            {"newStatus": "en_negociacion", "timestamp": "2026-01-09T10:00:00+00:00"},   # reabierta
            {"newStatus": "firmada", "timestamp": "2026-01-10T10:00:00+00:00"},
        ]
        assert plan_updates({}, logs) == {
            "statusDates.enviada": "2026-01-02T10:00:00+00:00",
            "statusDates.en_negociacion": "2026-01-09T10:00:00+00:00",
            "statusDates.firmada": "2026-01-10T10:00:00+00:00",
        }

    def test_never_overwrites_a_date_the_proposal_already_has(self):
        from scripts.migrations.backfill_status_dates import plan_updates
        proposal = {"statusDates": {"firmada": "2026-02-01T00:00:00+00:00"}}
        logs = [{"newStatus": "firmada", "timestamp": "2026-01-10T10:00:00+00:00"},
                {"newStatus": "enviada", "timestamp": "2026-01-02T10:00:00+00:00"}]
        assert plan_updates(proposal, logs) == {"statusDates.enviada": "2026-01-02T10:00:00+00:00"}

    def test_without_audit_logs_nothing_changes(self):
        from scripts.migrations.backfill_status_dates import plan_updates
        assert plan_updates({"proposal_status": "firmada"}, []) == {}

    def test_ignores_incomplete_log_entries(self):
        from scripts.migrations.backfill_status_dates import plan_updates
        assert plan_updates({}, [{"newStatus": "firmada"}, {"timestamp": "2026-01-01"}]) == {}
