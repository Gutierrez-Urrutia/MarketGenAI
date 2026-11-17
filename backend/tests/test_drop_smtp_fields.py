"""scripts/migrations/drop_smtp_fields.py over the in-memory Firestore
(tests/fake_firestore.py) — the real Firestore is never reached — with the
backup directory in a temporary folder. Synthetic data only."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

import pytest

from app.core.pipeline_constants import RETIRED_SMTP_CONFIG_FIELDS
from app.services import firestore_service as fs
from scripts.migrations import drop_smtp_fields as script
from tests.fake_firestore import use_fake_firestore

ENCRYPTED = "gAAAAA-fake-encrypted-smtp-password"
OLD = {
    "smtp_host": "smtp.example.test", "smtp_port": 587, "smtp_user": "smtp-user",
    "smtp_password_encrypted": ENCRYPTED, "sender_email": "ventas@example.test", "sender_name": "Equipo Ventas",
}
KEEP = {"keywords": ["BPO"], "outreach_real_send_enabled": True, "outreach_daily_send_limit": 20,
        "hunter_api_key_encrypted": "gAAAAA-fake-hunter"}


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(script, "BACKUP_DIR", tmp_path / "backups")
    with use_fake_firestore() as fake:
        fake.put("pipeline_configs", "user-a", {"userId": "user-a", **KEEP, **OLD})
        fake.put("pipeline_configs", "user-b", {"userId": "user-b", **KEEP, "smtp_host": "", "smtp_port": 587})
        fake.put("pipeline_configs", "user-c", {"userId": "user-c", **KEEP})  # already clean
        yield fake


def backups(db_tmp):
    return sorted(script.BACKUP_DIR.glob("*.json")) if script.BACKUP_DIR.exists() else []


async def run(*argv):
    return await script.main(list(argv))


def assert_private(output: str) -> None:
    """Counts only: no document id, address or stored value is printed."""
    for secret in ("user-a", "user-b", "user-c", ENCRYPTED, "smtp.example.test", "ventas@example.test",
                   "Equipo Ventas", "smtp-user"):
        assert secret not in output, secret


def test_it_removes_exactly_the_retired_smtp_settings():
    assert script.FIELDS == tuple(RETIRED_SMTP_CONFIG_FIELDS)


# ── Dry run ──────────────────────────────────────────────────────────────────
async def test_the_default_is_a_dry_run_that_prints_counts_only(db, capsys):
    assert await run() == script.EXIT_OK
    out = capsys.readouterr().out
    assert "documentos en pipeline_configs: 3" in out
    assert "documentos con campos SMTP: 2" in out
    assert "smtp_host: 2" in out and "smtp_password_encrypted: 1" in out and "sender_name: 1" in out
    assert "Simulación" in out
    assert_private(out)
    assert db.writes == [] and backups(db) == []


# ── Apply ────────────────────────────────────────────────────────────────────
async def test_apply_backs_up_first_then_deletes_only_the_smtp_fields(db, capsys, monkeypatch):
    order = []
    real_write_backup, real_drop = script.write_backup, script.drop_fields

    def write_backup(rows):
        order.append("backup")
        assert db.writes == []                     # nothing written before the backup exists
        return real_write_backup(rows)

    async def drop_fields(row):
        order.append("write")
        return await real_drop(row)

    monkeypatch.setattr(script, "write_backup", write_backup)
    monkeypatch.setattr(script, "drop_fields", drop_fields)

    assert await run("--apply", "--yes") == script.EXIT_OK
    assert order == ["backup", "write", "write"]

    a, b, c = (db.doc("pipeline_configs", user) for user in ("user-a", "user-b", "user-c"))
    for doc in (a, b, c):
        assert not any(field in doc for field in RETIRED_SMTP_CONFIG_FIELDS)
        assert {key: doc[key] for key in KEEP} == KEEP          # nothing else touched
    assert "updatedAt" in a and "updatedAt" not in c              # the clean one is not written
    assert {w[1] for w in db.writes_to("pipeline_configs")} == {"user-a", "user-b"}

    out = capsys.readouterr().out
    assert "Verificación: documentos del plan que aún tienen campos SMTP: 0" in out
    assert_private(out.split("Respaldo:")[0] + out.split("sha256:")[1])


async def test_the_backup_holds_the_exact_values_and_its_sha256_is_printed(db, capsys):
    await run("--apply", "--yes")
    [backup] = backups(db)
    rows = json.loads(backup.read_text(encoding="utf-8"))
    assert {row["id"]: row["fields"] for row in rows} == {
        "user-a": OLD, "user-b": {"smtp_host": "", "smtp_port": 587},
    }
    digest = hashlib.sha256(backup.read_bytes()).hexdigest()
    assert f"sha256: {digest}" in capsys.readouterr().out
    assert backup.name.startswith("drop_smtp_fields-") and backup.suffix == ".json"


async def test_without_confirmation_nothing_is_written(db, monkeypatch, capsys):
    monkeypatch.setattr("builtins.input", lambda prompt="": "no")
    assert await run("--apply") == script.EXIT_REFUSED
    assert db.writes == []
    assert len(backups(db)) == 1                     # the backup stays
    assert db.doc("pipeline_configs", "user-a")["smtp_password_encrypted"] == ENCRYPTED


async def test_a_field_changed_since_the_read_is_left_as_is(db, monkeypatch, capsys):
    real_write_backup = script.write_backup

    def write_backup_then_someone_edits(rows):
        path = real_write_backup(rows)
        db.data["pipeline_configs"]["user-a"]["smtp_host"] = "otro.example.test"
        return path

    monkeypatch.setattr(script, "write_backup", write_backup_then_someone_edits)
    assert await run("--apply", "--yes") == script.EXIT_ERRORS
    a = db.doc("pipeline_configs", "user-a")
    assert a["smtp_host"] == "otro.example.test" and a["smtp_password_encrypted"] == ENCRYPTED  # untouched
    assert "smtp_host" not in db.doc("pipeline_configs", "user-b")
    out = capsys.readouterr().out
    assert "CAMBIÓ: 1" in out and "aún tienen campos SMTP: 1" in out


async def test_a_second_run_finds_nothing_to_do(db, capsys):
    await run("--apply", "--yes")
    writes = len(db.writes)
    assert await run("--apply", "--yes") == script.EXIT_OK
    assert "Nada que borrar." in capsys.readouterr().out
    assert len(db.writes) == writes and len(backups(db)) == 1


async def test_the_writes_land_in_the_in_memory_firestore(db):
    assert fs.get_db() is db                          # never the real client
    await run("--apply", "--yes")
    assert db.writes_to("pipeline_configs")


# ── Restore ──────────────────────────────────────────────────────────────────
async def applied(db):
    await run("--apply", "--yes")
    [backup] = backups(db)
    return backup, hashlib.sha256(backup.read_bytes()).hexdigest()


async def test_restore_puts_every_field_back(db, capsys):
    before = {user: db.doc("pipeline_configs", user) for user in ("user-a", "user-b")}
    backup, digest = await applied(db)
    assert await run("--restore", str(backup), "--sha256", digest) == script.EXIT_OK   # dry run
    assert "restaurar 2" in capsys.readouterr().out
    assert "smtp_host" not in db.doc("pipeline_configs", "user-a")

    assert await run("--restore", str(backup), "--sha256", digest, "--apply", "--yes") == script.EXIT_OK
    for user, doc in before.items():
        now = db.doc("pipeline_configs", user)
        assert {k: v for k, v in now.items() if k != "updatedAt"} == {k: v for k, v in doc.items() if k != "updatedAt"}
    out = capsys.readouterr().out
    assert "documentos sin restaurar del todo: 0" in out
    assert_private(out)


async def test_restore_refuses_a_wrong_or_missing_sha256(db, capsys):
    backup, digest = await applied(db)
    writes = len(db.writes)
    assert await run("--restore", str(backup), "--sha256", "0" * 64, "--apply", "--yes") == script.EXIT_REFUSED
    assert await run("--restore", str(backup), "--apply", "--yes") == script.EXIT_REFUSED
    assert len(db.writes) == writes


async def test_restore_refuses_a_backup_that_was_edited(db):
    backup, _ = await applied(db)
    rows = json.loads(backup.read_text(encoding="utf-8"))
    rows[0]["fields"]["keywords"] = ["no permitido"]
    backup.write_text(json.dumps(rows), encoding="utf-8")
    digest = hashlib.sha256(backup.read_bytes()).hexdigest()   # even with a matching hash
    writes = len(db.writes)
    assert await run("--restore", str(backup), "--sha256", digest, "--apply", "--yes") == script.EXIT_REFUSED
    assert len(db.writes) == writes


async def test_restore_leaves_a_conflicting_document_untouched(db, capsys):
    backup, digest = await applied(db)
    db.data["pipeline_configs"]["user-a"]["smtp_host"] = "nuevo.example.test"
    assert await run("--restore", str(backup), "--sha256", digest, "--apply", "--yes") == script.EXIT_ERRORS
    a = db.doc("pipeline_configs", "user-a")
    assert a["smtp_host"] == "nuevo.example.test" and "smtp_password_encrypted" not in a
    assert db.doc("pipeline_configs", "user-b")["smtp_host"] == ""   # the other one is restored
    assert "CONFLICTO: 1" in capsys.readouterr().out


@pytest.mark.parametrize("rows, ok", [
    ([{"id": "u", "fields": {"smtp_host": "x"}}], True),
    ({"id": "u"}, False),
    ([{"id": "u", "fields": {}}], False),
    ([{"id": "", "fields": {"smtp_host": "x"}}], False),
    ([{"id": "u", "fields": {"smtp_host": "x"}, "extra": 1}], False),
    ([{"id": "u", "fields": {"is_active": False}}], False),
])
def test_validate_backup(rows, ok):
    assert (script.validate_backup(rows) is None) is ok


def test_classify_restore():
    row = {"id": "u", "fields": {"smtp_host": "x", "smtp_port": 587}}
    assert script.classify_restore(None, row) == script.GONE
    assert script.classify_restore({}, row) == script.WRITTEN
    assert script.classify_restore({"smtp_host": "x"}, row) == script.WRITTEN
    assert script.classify_restore({"smtp_host": "x", "smtp_port": 587}, row) == script.UNCHANGED
    assert script.classify_restore({"smtp_host": "y"}, row) == script.CONFLICT


def test_dates_in_a_backup_are_written_as_text():
    assert script._json_default(datetime(2026, 11, 14, tzinfo=timezone.utc)) == "2026-11-14T00:00:00+00:00"
