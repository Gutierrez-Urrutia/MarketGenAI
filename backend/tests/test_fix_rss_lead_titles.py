"""Tests for scripts/migrations/fix_rss_lead_titles.py. Firestore, the feed
and the backup directory are all faked — nothing real is read or written.

`FakeStore` stands in for the `leads` collection. Writes go through the
script's real `_guarded_update` (the body of the per-lead transaction) with
a fake transaction/ref over the store, so the re-check-before-write logic is
exercised as-is; only Firestore's transaction plumbing is faked."""
from __future__ import annotations

import copy
import json
from unittest.mock import AsyncMock, patch

import pytest
from google.cloud import firestore

from app.services import job_scout_service as svc
from scripts.migrations import fix_rss_lead_titles as fix

FEED_URL = "https://weworkremotely.com/x.rss"
FARO = "Faro: Full-Stack Product Engineer - Data First"


def stored_lead(lead_id: str, raw_title: str, **overrides) -> dict:
    """A lead as saved by the old global heuristic, before title_format."""
    job_title, company = svc._legacy_split_rss_title(raw_title)
    lead = {
        "id": lead_id,
        "job_title": job_title,
        "company_name": company,
        "fingerprint": svc.compute_fingerprint(company, job_title),
        "job_url": f"https://weworkremotely.com/remote-jobs/{lead_id}",
        "pipeline_config_id": "cfg",
        "source_id": "src",
        "status": "new",
        "relevance_score": 0.9,
        "pipeline_run_id": "run-1",
        "createdAt": f"2026-09-25T02:00:{lead_id[-2:]}",
    }
    lead.update(overrides)
    return lead


def config_with_source(title_format=None) -> dict:
    source_config = {"feed_url": FEED_URL}
    if title_format is not None:
        source_config["title_format"] = title_format
    return {"id": "cfg", "sources": [{"id": "src", "name": "Remote Jobs RSS", "source_type": "rss", "config": source_config}]}


class _Snap:
    def __init__(self, data):
        self.exists = data is not None
        self._data = data

    def to_dict(self):
        return copy.deepcopy(self._data)


class _Ref:
    def __init__(self, store, doc_id):
        self.store, self.id = store, doc_id

    async def get(self, transaction=None):
        return _Snap(self.store.docs.get(self.id))


class _Txn:
    def update(self, ref, data):
        doc = ref.store.docs[ref.id]
        for field, value in data.items():
            if value is firestore.DELETE_FIELD:
                doc.pop(field, None)
            else:
                doc[field] = value
        ref.store.writes.append((ref.id, data))


class FakeStore:
    def __init__(self, leads):
        self.docs = {lead["id"]: copy.deepcopy(lead) for lead in leads}
        self.writes = []
        self.before_write = None  # hook: mutate a doc between read and write

    async def guarded_update(self, lead_id, expected, data):
        if self.before_write:
            self.before_write(self, lead_id)
        return await fix._guarded_update(_Txn(), _Ref(self, lead_id), expected, data)

    async def stream(self, config_id, source_id):
        for doc in list(self.docs.values()):
            yield copy.deepcopy(doc)

    async def get(self, lead_id):
        doc = self.docs.get(lead_id)
        return copy.deepcopy(doc) if doc is not None else None


def _leads():
    return [
        stored_lead("l-01", "Acme: Senior Dev"),
        stored_lead("l-02", "Acme: Senior Dev"),  # duplicate of l-01
        stored_lead("l-03", FARO),
        stored_lead("l-04", "Tiendita: SDE II - Payments (Remote @ Peru)"),  # gone from feed
    ]


def _patches(store, config, tmp_path, feed=None):
    if feed is None:
        feed = {store.docs["l-03"]["job_url"]: FARO} if "l-03" in store.docs else {}
    return [
        patch.object(fix, "stream_source_leads", store.stream),
        patch.object(fix, "fetch_feed_titles", new_callable=AsyncMock, return_value=feed),
        patch.object(fix.pipeline_configs_repo, "get", new_callable=AsyncMock, return_value=config),
        patch.object(fix.leads_repo, "get", side_effect=store.get),
        patch.object(fix, "guarded_update", side_effect=store.guarded_update),
        patch.object(fix, "BACKUP_DIR", tmp_path / "backups"),
    ]


class _Patched:
    def __init__(self, patches):
        self.patches = patches

    def __enter__(self):
        return [p.__enter__() for p in self.patches]

    def __exit__(self, *exc):
        for p in reversed(self.patches):
            p.__exit__(*exc)
        return False


def _backup_files(tmp_path):
    return sorted((tmp_path / "backups").glob("*.json")) if (tmp_path / "backups").exists() else []


# ── plan_lead (pure) ─────────────────────────────────────────────────────────

def test_plan_direct_lead_splits_stored_title():
    plan = fix.plan_lead(stored_lead("l-01", "Acme: Senior Dev"), feed_titles={})

    assert plan.kind == fix.DIRECT
    assert (plan.raw_title, plan.company_name, plan.job_title) == ("Acme: Senior Dev", "Acme", "Senior Dev")
    assert plan.fingerprint == svc.compute_fingerprint("Acme", "Senior Dev")


def test_plan_feed_lead_recovers_original_title_and_cross_checks():
    lead = stored_lead("l-03", FARO)
    assert lead["company_name"] == "Data First"  # mis-split by the old heuristic

    plan = fix.plan_lead(lead, feed_titles={lead["job_url"]: FARO})

    assert plan.kind == fix.FEED
    assert plan.raw_title == FARO
    assert (plan.company_name, plan.job_title) == ("Faro", "Full-Stack Product Engineer - Data First")


def test_plan_feed_lead_missing_from_feed_goes_to_manual_review():
    lead = stored_lead("l-04", "Tiendita: SDE II - Payments (Remote @ Peru)")
    plan = fix.plan_lead(lead, feed_titles={})
    assert plan.kind == fix.MANUAL
    assert "ya no está en el feed" in plan.reason


def test_plan_feed_lead_unreadable_feed_goes_to_manual_review():
    lead = stored_lead("l-04", "Tiendita: SDE II - Payments (Remote @ Peru)")
    assert fix.plan_lead(lead, feed_titles=None).kind == fix.MANUAL


def test_plan_feed_lead_cross_check_mismatch_goes_to_manual_review():
    lead = stored_lead("l-05", "Brisa: Engineer - Python and SQL")
    # Same URL, but the feed now carries a different title.
    plan = fix.plan_lead(lead, feed_titles={lead["job_url"]: "Brisa: Engineer - Ruby and SQL"})
    assert plan.kind == fix.MANUAL
    assert "comprobación cruzada" in plan.reason


def test_plan_stored_fingerprint_mismatch_goes_to_manual_review():
    lead = stored_lead("l-06", "Acme: Dev", fingerprint="something-else")
    plan = fix.plan_lead(lead, feed_titles={})
    assert plan.kind == fix.MANUAL
    assert "huella" in plan.reason


def test_plan_skips_lead_that_already_has_raw_title():
    lead = {**stored_lead("l-07", "Acme: Dev"), "raw_title": "Acme: Dev"}
    assert fix.plan_lead(lead, feed_titles={}).kind == fix.SKIPPED


def test_plan_title_without_separator_keeps_fingerprint():
    lead = stored_lead("l-08", "Plain title")
    plan = fix.plan_lead(lead, feed_titles={})
    assert plan.kind == fix.DIRECT
    assert plan.company_name == ""
    assert plan.fingerprint == lead["fingerprint"]


# ── _guarded_update (transaction body) ──────────────────────────────────────

@pytest.mark.asyncio
async def test_guarded_update_writes_only_given_fields_plus_updated_at():
    store = FakeStore([stored_lead("l-01", "Acme: Senior Dev")])
    before = copy.deepcopy(store.docs["l-01"])
    expected = {**fix.original_values(before), "raw_title": None}
    data = {"raw_title": "Acme: Senior Dev", "job_title": "Senior Dev", "company_name": "Acme", "fingerprint": "fp"}

    outcome = await fix._guarded_update(_Txn(), _Ref(store, "l-01"), expected, data)

    assert outcome == fix.WRITTEN
    [(_, written)] = store.writes
    assert set(written) == {"raw_title", "job_title", "company_name", "fingerprint", "updatedAt"}
    after = store.docs["l-01"]
    for untouched in ("status", "relevance_score", "createdAt", "job_url", "pipeline_run_id"):
        assert after[untouched] == before[untouched]


@pytest.mark.asyncio
async def test_guarded_update_does_not_write_when_doc_changed_or_deleted():
    store = FakeStore([stored_lead("l-01", "Acme: Senior Dev")])
    expected = {**fix.original_values(store.docs["l-01"]), "raw_title": None}
    store.docs["l-01"]["raw_title"] = "set by someone else"

    assert await fix._guarded_update(_Txn(), _Ref(store, "l-01"), expected, {"job_title": "x"}) == fix.CHANGED
    assert await fix._guarded_update(_Txn(), _Ref(store, "missing"), expected, {"job_title": "x"}) == fix.GONE
    assert store.writes == []


# ── run(): dry run / refusal ─────────────────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("title_format", [None, "company_colon_title"])
async def test_dry_run_never_writes_nor_backs_up(tmp_path, capsys, title_format):
    store = FakeStore(_leads())
    with _Patched(_patches(store, config_with_source(title_format), tmp_path)), \
            patch("builtins.input") as mock_input:
        summary = await fix.run("cfg", "src", apply=False)

    assert store.writes == []
    mock_input.assert_not_called()
    assert _backup_files(tmp_path) == []
    assert summary["read"] == 4
    assert (summary["direct"], summary["feed"], summary["manual"], summary["skipped"]) == (2, 1, 1, 0)
    assert (summary["duplicate_groups"], summary["duplicate_extra_docs"]) == (1, 1)
    out = capsys.readouterr().out
    assert "SIMULACIÓN" in out
    assert f"'{FARO}'" in out
    assert "DUPLICADO de l-01" in out
    assert "REVISIÓN MANUAL: la oferta ya no está en el feed" in out


@pytest.mark.asyncio
@pytest.mark.parametrize("title_format", [None, "none"])
async def test_apply_refused_unless_source_has_company_colon_title(tmp_path, capsys, title_format):
    store = FakeStore(_leads())
    with _Patched(_patches(store, config_with_source(title_format), tmp_path)) as mocks:
        summary = await fix.run("cfg", "src", apply=True)

    assert summary == {"refused": True}
    assert fix.exit_code(summary) == fix.EXIT_REFUSED
    assert store.writes == []
    mocks[1].assert_not_called()  # feed not even fetched
    assert _backup_files(tmp_path) == []
    assert "--apply rechazado" in capsys.readouterr().out


# ── run(): apply ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_apply_writes_backup_before_first_update(tmp_path):
    store = FakeStore(_leads())
    backups_at_first_write = []
    store.before_write = lambda s, lead_id: backups_at_first_write.append(_backup_files(tmp_path))

    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input", return_value="yes"):
        summary = await fix.run("cfg", "src", apply=True)

    assert backups_at_first_write[0], "backup must exist before the first write"
    rows = json.loads(backups_at_first_write[0][0].read_text(encoding="utf-8"))
    assert [row["id"] for row in rows] == ["l-01", "l-02", "l-03"]
    assert rows[2]["original"] == {
        "job_title": "Faro: Full-Stack Product Engineer",
        "company_name": "Data First",
        "fingerprint": svc.compute_fingerprint("Data First", "Faro: Full-Stack Product Engineer"),
    }
    assert rows[2]["applied"] == {
        "raw_title": FARO,
        "job_title": "Full-Stack Product Engineer - Data First",
        "company_name": "Faro",
        "fingerprint": svc.compute_fingerprint("Faro", "Full-Stack Product Engineer - Data First"),
    }
    assert (summary["written"], summary["errors"], summary["changed"]) == (3, 0, 0)
    assert fix.exit_code(summary) == fix.EXIT_OK
    assert "raw_title" not in store.docs["l-04"]  # manual review: untouched
    assert store.docs["l-03"]["company_name"] == "Faro"


@pytest.mark.asyncio
async def test_apply_skips_lead_changed_between_read_and_write(tmp_path, capsys):
    store = FakeStore(_leads())

    def someone_edits_l02(s, lead_id):
        if lead_id == "l-02":
            s.docs["l-02"]["company_name"] = "Edited by hand"

    store.before_write = someone_edits_l02
    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input", return_value="yes"):
        summary = await fix.run("cfg", "src", apply=True)

    assert (summary["written"], summary["changed"], summary["errors"]) == (2, 1, 0)
    assert store.docs["l-02"]["company_name"] == "Edited by hand"
    assert "raw_title" not in store.docs["l-02"]
    out = capsys.readouterr().out
    assert "lead l-02  CAMBIÓ DESDE LA LECTURA" in out
    assert "2 escritos · 0 con error · 1 cambió desde la lectura · 1 omitidos" in out


@pytest.mark.asyncio
async def test_apply_counts_errors_and_exits_non_zero(tmp_path):
    store = FakeStore(_leads())

    def fail_on_l01(s, lead_id):
        if lead_id == "l-01":
            raise RuntimeError("deadline exceeded")

    store.before_write = fail_on_l01
    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input", return_value="yes"):
        summary = await fix.run("cfg", "src", apply=True)

    assert (summary["written"], summary["errors"]) == (2, 1)
    assert fix.exit_code(summary) == fix.EXIT_ERRORS


@pytest.mark.asyncio
async def test_apply_without_typed_yes_writes_nothing(tmp_path):
    store = FakeStore(_leads())
    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input", return_value="no"):
        summary = await fix.run("cfg", "src", apply=True)

    assert store.writes == []
    assert summary["written"] == 0


@pytest.mark.asyncio
async def test_apply_rerun_after_completion_does_nothing(tmp_path):
    store = FakeStore(_leads())
    config = config_with_source("company_colon_title")
    with _Patched(_patches(store, config, tmp_path)), patch("builtins.input", return_value="yes"):
        await fix.run("cfg", "src", apply=True)
        writes_after_first = len(store.writes)
        summary = await fix.run("cfg", "src", apply=True)

    assert len(store.writes) == writes_after_first
    assert (summary["skipped"], summary["manual"], summary["written"]) == (3, 1, 0)


# ── run(): --only ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_only_writes_and_backs_up_just_that_lead(tmp_path, capsys):
    store = FakeStore(_leads())
    untouched = {lead_id: copy.deepcopy(doc) for lead_id, doc in store.docs.items() if lead_id != "l-03"}

    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input", return_value="yes"):
        summary = await fix.run("cfg", "src", apply=True, only="l-03")

    assert [lead_id for lead_id, _ in store.writes] == ["l-03"]
    assert store.docs["l-03"]["company_name"] == "Faro"
    for lead_id, doc in untouched.items():
        assert store.docs[lead_id] == doc
    [backup] = _backup_files(tmp_path)
    assert backup.name.endswith("-only-l-03.json")
    assert [row["id"] for row in json.loads(backup.read_text(encoding="utf-8"))] == ["l-03"]
    assert (summary["read"], summary["feed"], summary["written"], summary["only"]) == (1, 1, 1, "l-03")
    out = capsys.readouterr().out
    assert "Resumen (--only: solo el lead l-03): 1 leídos" in out
    assert "Respaldo de 1 lead(s) (--only: solo el lead l-03)" in out
    assert "Resultado (--only: solo el lead l-03): 1 escritos" in out


@pytest.mark.asyncio
@pytest.mark.parametrize("lead_id, why", [
    ("no-such-lead", "no es un lead de esta fuente"),
    ("l-04", "está como REVISIÓN MANUAL"),  # not in the feed anymore
])
async def test_only_rejects_lead_not_in_plan(tmp_path, capsys, lead_id, why):
    store = FakeStore(_leads())
    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input") as mock_input:
        summary = await fix.run("cfg", "src", apply=True, only=lead_id)

    assert fix.exit_code(summary) == fix.EXIT_REFUSED
    assert store.writes == []
    assert _backup_files(tmp_path) == []
    mock_input.assert_not_called()
    out = capsys.readouterr().out
    assert f"--only {lead_id} rechazado: no está en el plan" in out
    assert why in out


@pytest.mark.asyncio
async def test_only_rejects_lead_already_fixed(tmp_path):
    store = FakeStore(_leads())
    store.docs["l-01"]["raw_title"] = "Acme: Senior Dev"
    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)):
        summary = await fix.run("cfg", "src", apply=True, only="l-01")

    assert summary == {"refused": True}
    assert store.writes == []


@pytest.mark.asyncio
async def test_unknown_source_does_nothing(tmp_path):
    store = FakeStore(_leads())
    with _Patched(_patches(store, {"sources": []}, tmp_path)) as mocks:
        summary = await fix.run("cfg", "src", apply=False)

    assert summary == {"refused": True}
    mocks[1].assert_not_called()
    assert store.writes == []


# ── restore ──────────────────────────────────────────────────────────────────

async def _apply_and_get_backup(store, tmp_path):
    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input", return_value="yes"):
        await fix.run("cfg", "src", apply=True)
    [backup] = _backup_files(tmp_path)
    return backup


@pytest.mark.asyncio
async def test_full_cycle_apply_then_restore_leaves_fields_as_they_were(tmp_path):
    originals = _leads()
    store = FakeStore(originals)
    backup = await _apply_and_get_backup(store, tmp_path)
    assert store.docs["l-01"]["company_name"] == "Acme"

    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input", return_value="yes"):
        summary = await fix.run_restore(backup, True, "cfg", "src")

    assert (summary["restored"], summary["errors"], summary["changed"]) == (3, 0, 0)
    for lead in originals:
        doc = store.docs[lead["id"]]
        for field in ("job_title", "company_name", "fingerprint"):
            assert doc[field] == lead[field], (lead["id"], field)
        assert "raw_title" not in doc
        assert doc["status"] == lead["status"]


@pytest.mark.asyncio
async def test_restore_dry_run_never_writes(tmp_path, capsys):
    store = FakeStore(_leads())
    backup = await _apply_and_get_backup(store, tmp_path)
    writes_after_apply = len(store.writes)

    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input") as mock_input:
        summary = await fix.run_restore(backup, False, "cfg", "src")

    assert len(store.writes) == writes_after_apply
    mock_input.assert_not_called()
    assert summary["to_restore"] == 3
    assert "SIMULACIÓN" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_restore_respects_conflicts_and_reports_unchanged_and_missing(tmp_path, capsys):
    store = FakeStore(_leads())
    backup = await _apply_and_get_backup(store, tmp_path)
    rows = {row["id"]: row for row in json.loads(backup.read_text(encoding="utf-8"))}

    # l-01: edited by hand after the fix → differs from applied AND original.
    store.docs["l-01"]["company_name"] = "Edited by hand"
    # l-02: already back on its original values → SIN CAMBIO.
    store.docs["l-02"].update(rows["l-02"]["original"])
    store.docs["l-02"].pop("raw_title")
    # l-03: deleted → NO EXISTE.
    del store.docs["l-03"]
    writes_before = len(store.writes)

    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input", return_value="yes"):
        summary = await fix.run_restore(backup, True, "cfg", "src")

    assert (summary["conflicts"], summary["unchanged"], summary["missing"], summary["to_restore"]) == (1, 1, 1, 0)
    assert len(store.writes) == writes_before
    assert store.docs["l-01"]["company_name"] == "Edited by hand"
    out = capsys.readouterr().out
    assert "lead l-01  CONFLICTO" in out
    assert "lead l-02  SIN CAMBIO" in out
    assert "lead l-03  NO EXISTE" in out


@pytest.mark.asyncio
async def test_restore_skips_lead_changed_between_read_and_write(tmp_path):
    store = FakeStore(_leads())
    backup = await _apply_and_get_backup(store, tmp_path)

    def someone_edits_l01(s, lead_id):
        if lead_id == "l-01":
            s.docs["l-01"]["job_title"] = "Edited by hand"

    store.before_write = someone_edits_l01
    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)), \
            patch("builtins.input", return_value="yes"):
        summary = await fix.run_restore(backup, True, "cfg", "src")

    assert (summary["restored"], summary["changed"]) == (2, 1)
    assert store.docs["l-01"]["job_title"] == "Edited by hand"
    assert store.docs["l-01"]["raw_title"] == "Acme: Senior Dev"


@pytest.mark.asyncio
async def test_restore_rejects_malformed_backup(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps([{"id": "l-01", "job_title": "x"}]), encoding="utf-8")
    with patch.object(fix.leads_repo, "get", new_callable=AsyncMock) as mock_get:
        summary = await fix.run_restore(bad, True, "cfg", "src")

    assert fix.exit_code(summary) == fix.EXIT_REFUSED
    mock_get.assert_not_called()



def _valid_row(lead_id="l-01"):
    return {
        "id": lead_id,
        "original": {"job_title": "Acme: Dev", "company_name": "", "fingerprint": "fp-old"},
        "applied": {"raw_title": "Acme: Dev", "job_title": "Dev", "company_name": "Acme", "fingerprint": "fp-new"},
    }


def test_load_backup_accepts_exactly_what_write_backup_produces(tmp_path):
    store = FakeStore(_leads())
    lead = store.docs["l-01"]
    plan = fix.plan_lead(lead, feed_titles={})
    with patch.object(fix, "BACKUP_DIR", tmp_path / "backups"):
        path = fix.write_backup("cfg", [(lead, plan)])
    assert [row["id"] for row in fix.load_backup(path)] == ["l-01"]


@pytest.mark.parametrize("label, mutate", [
    ("not a list", lambda rows: {"rows": rows}),
    ("empty", lambda rows: []),
    ("extra top-level key", lambda rows: [{**rows[0], "userId": "x"}]),
    ("missing id", lambda rows: [{k: v for k, v in rows[0].items() if k != "id"}]),
    ("empty id", lambda rows: [{**rows[0], "id": ""}]),
    ("repeated id", lambda rows: rows + rows),
    ("extra field in original", lambda rows: [{**rows[0], "original": {**rows[0]["original"], "status": "sent"}}]),
    ("config field in original", lambda rows: [{**rows[0], "original": {**rows[0]["original"], "pipeline_config_id": "other"}}]),
    ("missing field in original", lambda rows: [{**rows[0], "original": {"job_title": "x", "company_name": ""}}]),
    ("non-text in original", lambda rows: [{**rows[0], "original": {**rows[0]["original"], "fingerprint": None}}]),
    ("applied empty", lambda rows: [{**rows[0], "applied": {}}]),
    ("applied missing raw_title", lambda rows: [{**rows[0], "applied": rows[0]["original"]}]),
    ("extra field in applied", lambda rows: [{**rows[0], "applied": {**rows[0]["applied"], "userId": "x"}}]),
    ("non-text in applied", lambda rows: [{**rows[0], "applied": {**rows[0]["applied"], "raw_title": 1}}]),
])
def test_load_backup_rejects_malformed_or_tampered_rows(tmp_path, label, mutate):
    path = tmp_path / "b.json"
    path.write_text(json.dumps(mutate([_valid_row()])), encoding="utf-8")
    with pytest.raises(ValueError):
        fix.load_backup(path)


@pytest.mark.asyncio
async def test_restore_never_touches_lead_of_another_config_or_source(tmp_path, capsys):
    store = FakeStore(_leads())
    backup = await _apply_and_get_backup(store, tmp_path)
    store.docs["l-01"]["pipeline_config_id"] = "other-cfg"
    store.docs["l-02"]["source_id"] = "other-src"
    writes_before = len(store.writes)

    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)),             patch("builtins.input", return_value="yes"):
        summary = await fix.run_restore(backup, True, "cfg", "src")

    assert (summary["foreign"], summary["restored"]) == (2, 1)
    assert [lead_id for lead_id, _ in store.writes[writes_before:]] == ["l-03"]
    assert store.docs["l-01"]["raw_title"] == "Acme: Senior Dev"  # untouched
    out = capsys.readouterr().out
    assert "lead l-01  NO PERTENECE" in out
    assert "lead l-02  NO PERTENECE" in out


@pytest.mark.asyncio
async def test_restore_transaction_rechecks_ownership_before_writing(tmp_path):
    store = FakeStore(_leads())
    backup = await _apply_and_get_backup(store, tmp_path)

    def moved_to_other_config(s, lead_id):
        if lead_id == "l-01":
            s.docs["l-01"]["pipeline_config_id"] = "other-cfg"

    store.before_write = moved_to_other_config
    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)),             patch("builtins.input", return_value="yes"):
        summary = await fix.run_restore(backup, True, "cfg", "src")

    assert (summary["restored"], summary["changed"]) == (2, 1)
    assert store.docs["l-01"]["raw_title"] == "Acme: Senior Dev"


@pytest.mark.asyncio
async def test_apply_transaction_rechecks_ownership_before_writing(tmp_path):
    store = FakeStore(_leads())

    def moved_to_other_source(s, lead_id):
        if lead_id == "l-01":
            s.docs["l-01"]["source_id"] = "other-src"

    store.before_write = moved_to_other_source
    with _Patched(_patches(store, config_with_source("company_colon_title"), tmp_path)),             patch("builtins.input", return_value="yes"):
        summary = await fix.run("cfg", "src", apply=True)

    assert (summary["written"], summary["changed"]) == (2, 1)
    assert "raw_title" not in store.docs["l-01"]

# ── CLI / output ─────────────────────────────────────────────────────────────

def test_parse_args_always_requires_config_and_source():
    ids = ["--config-id", "cfg", "--source-id", "src"]
    with pytest.raises(SystemExit):
        fix.parse_args([])
    with pytest.raises(SystemExit):
        fix.parse_args(["--restore", "x.json"])
    with pytest.raises(SystemExit):
        fix.parse_args(["--restore", "x.json", "--config-id", "cfg"])
    with pytest.raises(SystemExit):
        fix.parse_args([*ids, "--restore", "x.json", "--only", "l-01"])
    assert fix.parse_args([*ids, "--only", "l-01"]).only == "l-01"
    args = fix.parse_args([*ids, "--restore", "x.json"])
    assert (args.restore.name, args.config_id, args.source_id) == ("x.json", "cfg", "src")
    args = fix.parse_args(ids)
    assert (args.config_id, args.source_id, args.apply) == ("cfg", "src", False)


def test_say_flushes_every_line():
    with patch("builtins.print") as mock_print:
        fix.say("hola")
    mock_print.assert_called_once_with("hola", flush=True)
