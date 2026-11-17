"""One-off: remove the settings of the removed SMTP sending from
pipeline_configs (RF-VTA-16, phase 2b).

Older pipeline_configs documents still hold the SMTP account —
RETIRED_SMTP_CONFIG_FIELDS: smtp_host, smtp_port, smtp_user,
smtp_password_encrypted (the SMTP password, encrypted), sender_email and
sender_name. The API already ignores them (routers/pipeline.py
RETIRED_CONFIG_FIELDS); this script deletes them from Firestore. Nothing else
in a document is ever touched.

Default is a DRY RUN: it reads and prints COUNTS only (documents, and how many
hold each field). No document id, address or value is printed, ever.

With --apply:
  1. writes a JSON backup to scripts/migrations/backups/ (git-ignored: it
     holds real data, including the encrypted SMTP password) BEFORE the first
     write, with, per document, its id and the exact values to be deleted;
     prints the backup's path and sha256;
  2. asks for a typed 'yes' (or --yes);
  3. per document, inside a Firestore transaction that re-reads it, deletes
     only the fields whose value is still the one in the backup (a field that
     changed since the read is left as is: CAMBIÓ);
  4. verifies: re-reads every document and counts those that still hold any
     of the fields.
Safe to re-run: documents already clean are not in the plan.

--restore <backup.json> --sha256 <hex> puts the fields back from a backup
(dry run by default, writes with --apply). The file's sha256 must match
--sha256 (the one printed by --apply), and every row must have exactly `id`
and `fields`, with only RETIRED_SMTP_CONFIG_FIELDS in `fields` — anything
else and nothing is done. Per document, inside a transaction: a field that is
absent is set back; one that already holds the backup's value is left
(SIN CAMBIO); one holding something else is a CONFLICTO and the document is
not touched.

Exit code: 0 ok, 1 if any write or verification failed, 2 if the run was refused.

Usage (from backend/, with the venv active):

    # Dry run (default): counts only, writes nothing
    python -u -m scripts.migrations.drop_smtp_fields

    # Apply (backup first, then asks for 'yes')
    python -u -m scripts.migrations.drop_smtp_fields --apply

    # Restore from a backup: dry run, then apply
    python -u -m scripts.migrations.drop_smtp_fields --restore scripts/migrations/backups/<file>.json --sha256 <hex>
    python -u -m scripts.migrations.drop_smtp_fields --restore scripts/migrations/backups/<file>.json --sha256 <hex> --apply
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from google.cloud import firestore

from app.config import settings
from app.core.pipeline_constants import RETIRED_SMTP_CONFIG_FIELDS
# Through the module, never `from … import get_db`: the tests swap
# firestore_service.get_db for the in-memory Firestore, and a name imported
# here would keep pointing at the real one.
from app.services import firestore_service as fs

FIELDS = tuple(RETIRED_SMTP_CONFIG_FIELDS)
BACKUP_DIR = Path(__file__).resolve().parent / "backups"
BACKUP_ROW_KEYS = {"id", "fields"}

# Outcomes of one guarded (transactional) write
WRITTEN = "written"
CHANGED = "CAMBIÓ"
GONE = "NO EXISTE"
UNCHANGED = "SIN CAMBIO"
CONFLICT = "CONFLICTO"

EXIT_OK, EXIT_ERRORS, EXIT_REFUSED = 0, 1, 2


class _Missing:
    """Stands for "the field is not in the document" (unlike a None value)."""


_MISSING = _Missing()


def say(message: str = "") -> None:
    print(message, flush=True)


# ── Pure helpers ─────────────────────────────────────────────────────────────
def retired_values(doc: Dict[str, Any]) -> Dict[str, Any]:
    """The retired SMTP fields the document holds, with their values."""
    return {field: doc[field] for field in FIELDS if field in doc}


def plan_rows(docs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One backup row per document that holds any retired field. Pure."""
    rows = []
    for doc in docs:
        values = retired_values(doc)
        if values:
            rows.append({"id": doc["id"], "fields": values})
    return rows


def field_counts(rows: List[Dict[str, Any]]) -> Dict[str, int]:
    return {field: sum(1 for row in rows if field in row["fields"]) for field in FIELDS}


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"not serializable: {type(value).__name__}")


def validate_backup(rows: Any) -> Optional[str]:
    """None when the backup is usable, else why not. Pure."""
    if not isinstance(rows, list):
        return "el respaldo no es una lista"
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or set(row) != BACKUP_ROW_KEYS:
            return f"fila {index}: debe tener exactamente {sorted(BACKUP_ROW_KEYS)}"
        if not isinstance(row["id"], str) or not row["id"]:
            return f"fila {index}: id inválido"
        if not isinstance(row["fields"], dict) or not row["fields"]:
            return f"fila {index}: fields vacío o inválido"
        unknown = set(row["fields"]) - set(FIELDS)
        if unknown:
            return f"fila {index}: campos no permitidos"
    return None


def classify_restore(current: Optional[Dict[str, Any]], row: Dict[str, Any]) -> str:
    """What --restore does with one row, given the document now. Pure."""
    if current is None:
        return GONE
    pending = False
    for field, value in row["fields"].items():
        if field not in current:
            pending = True
        elif current[field] != value:
            return CONFLICT
    return WRITTEN if pending else UNCHANGED


# ── Firestore I/O (the tests run it over the in-memory Firestore) ────────────
def _ref(doc_id: str):
    return fs.get_db().collection(fs.pipeline_configs_repo.collection).document(doc_id)


async def read_all() -> List[Dict[str, Any]]:
    snaps = await fs.get_db().collection(fs.pipeline_configs_repo.collection).get()
    return [{**(snap.to_dict() or {}), "id": snap.id} for snap in snaps if snap.exists]


async def drop_fields(row: Dict[str, Any]) -> str:
    """Delete the row's fields from its document, only those still holding
    the backup's value. Returns WRITTEN, CHANGED (some field changed: none
    deleted) or GONE."""
    ref = _ref(row["id"])
    transaction = fs.get_db().transaction()

    @firestore.async_transactional
    async def _txn(txn):
        snap = await ref.get(transaction=txn)
        if not snap.exists:
            return GONE
        current = snap.to_dict() or {}
        if any(current.get(field, _MISSING) != value for field, value in row["fields"].items()):
            return CHANGED
        txn.update(ref, {**{field: firestore.DELETE_FIELD for field in row["fields"]}, "updatedAt": fs.now_utc()})
        return WRITTEN

    return await _txn(transaction)


async def restore_fields(row: Dict[str, Any]) -> str:
    ref = _ref(row["id"])
    transaction = fs.get_db().transaction()

    @firestore.async_transactional
    async def _txn(txn):
        snap = await ref.get(transaction=txn)
        current = (snap.to_dict() or {}) if snap.exists else None
        outcome = classify_restore(current, row)
        if outcome == WRITTEN:
            missing = {field: value for field, value in row["fields"].items() if field not in current}
            txn.update(ref, {**missing, "updatedAt": fs.now_utc()})
        return outcome

    return await _txn(transaction)


def write_backup(rows: List[Dict[str, Any]]) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    project = (settings.google_cloud_project or "proyecto").replace("/", "_")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = BACKUP_DIR / f"drop_smtp_fields-{project}-{stamp}.json"
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    return path


def confirm(assume_yes: bool) -> bool:
    if assume_yes:
        return True
    return input("Escribe 'yes' para continuar: ").strip() == "yes"


# ── Runs ─────────────────────────────────────────────────────────────────────
def print_counts(title: str, total: int, rows: List[Dict[str, Any]]) -> None:
    say(title)
    say(f"  documentos en pipeline_configs: {total}")
    say(f"  documentos con campos SMTP: {len(rows)}")
    for field, count in field_counts(rows).items():
        say(f"    {field}: {count}")


async def run_drop(apply: bool, assume_yes: bool) -> int:
    docs = await read_all()
    rows = plan_rows(docs)
    print_counts("Plan (solo conteos):", len(docs), rows)
    if not apply:
        say("Simulación: no se escribió nada. Usa --apply para borrar (con respaldo previo).")
        return EXIT_OK
    if not rows:
        say("Nada que borrar.")
        return EXIT_OK

    backup = write_backup(rows)
    digest = sha256_of(backup)
    say(f"Respaldo: {backup}")
    say(f"sha256: {digest}")
    say("El respaldo contiene la contraseña SMTP cifrada: no lo compartas ni lo subas.")
    if not confirm(assume_yes):
        say("Cancelado: no se escribió nada (el respaldo queda).")
        return EXIT_REFUSED

    outcomes = {WRITTEN: 0, CHANGED: 0, GONE: 0}
    failed = 0
    for row in rows:
        try:
            outcomes[await drop_fields(row)] += 1
        except Exception as exc:  # noqa: BLE001 — keep going, report at the end
            failed += 1
            say(f"  error de escritura ({type(exc).__name__})")
    say(f"Borrados: {outcomes[WRITTEN]} · {CHANGED}: {outcomes[CHANGED]} · {GONE}: {outcomes[GONE]} · errores: {failed}")

    remaining = plan_rows(await read_all())
    still = sum(1 for row in remaining if row["id"] in {r["id"] for r in rows})
    say(f"Verificación: documentos del plan que aún tienen campos SMTP: {still}")
    return EXIT_OK if failed == 0 and still == 0 else EXIT_ERRORS


async def run_restore(path: Path, expected_sha256: Optional[str], apply: bool, assume_yes: bool) -> int:
    if not path.is_file():
        say("Respaldo no encontrado.")
        return EXIT_REFUSED
    if not expected_sha256 or sha256_of(path) != expected_sha256.strip().lower():
        say("El sha256 del respaldo no coincide con --sha256: no se hace nada.")
        return EXIT_REFUSED
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        say("El respaldo no es JSON válido: no se hace nada.")
        return EXIT_REFUSED
    problem = validate_backup(rows)
    if problem:
        say(f"Respaldo inválido ({problem}): no se hace nada.")
        return EXIT_REFUSED

    current = {doc["id"]: doc for doc in await read_all()}
    plan: Dict[str, int] = {WRITTEN: 0, UNCHANGED: 0, CONFLICT: 0, GONE: 0}
    for row in rows:
        plan[classify_restore(current.get(row["id"]), row)] += 1
    say(f"Plan de restauración: restaurar {plan[WRITTEN]} · {UNCHANGED}: {plan[UNCHANGED]} · "
        f"{CONFLICT}: {plan[CONFLICT]} · {GONE}: {plan[GONE]}")
    if not apply:
        say("Simulación: no se escribió nada. Usa --apply para restaurar.")
        return EXIT_OK
    if not confirm(assume_yes):
        say("Cancelado: no se escribió nada.")
        return EXIT_REFUSED

    done: Dict[str, int] = {WRITTEN: 0, UNCHANGED: 0, CONFLICT: 0, GONE: 0}
    failed = 0
    for row in rows:
        try:
            done[await restore_fields(row)] += 1
        except Exception as exc:  # noqa: BLE001
            failed += 1
            say(f"  error de escritura ({type(exc).__name__})")
    say(f"Restaurados: {done[WRITTEN]} · {UNCHANGED}: {done[UNCHANGED]} · {CONFLICT}: {done[CONFLICT]} · "
        f"{GONE}: {done[GONE]} · errores: {failed}")
    after = {doc["id"]: doc for doc in await read_all()}
    mismatched = sum(
        1 for row in rows
        if row["id"] in after and classify_restore(after[row["id"]], row) not in (UNCHANGED, CONFLICT)
    )
    say(f"Verificación: documentos sin restaurar del todo: {mismatched}")
    return EXIT_OK if failed == 0 and mismatched == 0 and done[CONFLICT] == 0 else EXIT_ERRORS


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Borra los campos SMTP retirados de pipeline_configs.")
    parser.add_argument("--apply", action="store_true", help="escribir (por defecto solo simula)")
    parser.add_argument("--yes", action="store_true", help="no pedir confirmación")
    parser.add_argument("--restore", type=Path, help="restaurar desde este respaldo JSON")
    parser.add_argument("--sha256", help="sha256 esperado del respaldo (obligatorio con --restore)")
    return parser.parse_args(argv)


async def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    if args.restore:
        return await run_restore(args.restore, args.sha256, args.apply, args.yes)
    return await run_drop(args.apply, args.yes)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
