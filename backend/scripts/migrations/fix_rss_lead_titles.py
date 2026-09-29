"""One-off fix: re-split the titles of leads saved by an RSS source before
it had `config.title_format` (Fase 2, punto 4).

Before title_format existed, job_scout_service split every RSS title with a
global heuristic (" at " / " - " / " | "). For weworkremotely.com
("Company: Job title") that left the company empty on most leads, and on a
few split the title at the wrong place. This script rewrites those leads as
if they had been saved with title_format="company_colon_title":
`job_title`, `company_name`, `fingerprint` and `raw_title` (plus `updatedAt`,
same convention as leads_repo.update). Nothing else — score, status and
createdAt are never touched. Every write is a partial update.

For each lead of the source that has no `raw_title` yet (so a second run
does nothing):
  - DIRECTO: company_name is empty, so the stored job_title IS the original
    RSS title.
  - FEED: company_name is not empty (the heuristic split the title). The
    original title is read from the source's current feed, matched by
    job_url. Read-only GET, same SSRF/size checks as a scan.
  - REVISIÓN MANUAL: the posting is no longer in the feed, the feed can't be
    read, or the cross-check fails. The lead is left untouched.
Cross-check (DIRECTO and FEED): the old heuristic applied to the original
title must give back exactly the stored job_title / company_name, and the
stored fingerprint. Anything else goes to REVISIÓN MANUAL.

Duplicates (same final fingerprint within the config) are only REPORTED —
nothing is deleted or marked.

Default is a dry run: nothing is written. With --apply it:
  1. refuses unless the source already has
     title_format="company_colon_title" (otherwise the next scan would save
     the same postings again under a different fingerprint),
  2. writes a local backup to scripts/migrations/backups/ — git-ignored, it
     holds real data — BEFORE the first write: per lead, the original
     job_title / company_name / fingerprint and the values about to be
     applied,
  3. asks for a typed 'yes', then updates one lead at a time, each inside a
     Firestore transaction that re-reads the lead and only writes if it is
     still exactly as it was read (no raw_title, same title/company/
     fingerprint) — otherwise "CAMBIÓ DESDE LA LECTURA", untouched.
Safe to re-run after an interruption: each lead is written atomically, the
ones already done have raw_title and are skipped.

--restore <backup.json> undoes an --apply from its backup (dry run by
default, writes with --apply). It also needs --config-id / --source-id, and
only ever touches leads of that config and source. The backup is validated
first: each row must have exactly `id`, `original` (job_title,
company_name, fingerprint) and `applied` (those + raw_title), all text —
anything else and nothing is done. Per lead, inside a transaction:
  - belongs to another config/source → NO PERTENECE, untouched;
  - still has the applied values → RESTAURAR: original job_title /
    company_name / fingerprint back, raw_title removed;
  - already has its original values → SIN CAMBIO;
  - differs from both → CONFLICTO, untouched; deleted → NO EXISTE.

Uses job_scout_service._legacy_split_rss_title only to cross-check, never to
decide what gets stored. Keep that legacy helper as long as a restore is
possible (see its comment in job_scout_service.py).

Exit code: 0 ok, 1 if any write failed, 2 if the run was refused.

Usage (from backend/, with the venv active):

    # Dry run (default) — reads Firestore and the feed, writes nothing
    python -u -m scripts.migrations.fix_rss_lead_titles --config-id <CONFIG_ID> --source-id <SOURCE_ID>

    # Apply (asks for confirmation 'yes')
    python -u -m scripts.migrations.fix_rss_lead_titles --config-id <CONFIG_ID> --source-id <SOURCE_ID> --apply

    # Just one lead (its own backup; refused if the lead isn't in the plan)
    python -u -m scripts.migrations.fix_rss_lead_titles --config-id <CONFIG_ID> --source-id <SOURCE_ID> --only <LEAD_ID> --apply

    # Restore from a backup: dry run, then apply
    python -u -m scripts.migrations.fix_rss_lead_titles --config-id <CONFIG_ID> --source-id <SOURCE_ID> --restore scripts/migrations/backups/<file>.json
    python -u -m scripts.migrations.fix_rss_lead_titles --config-id <CONFIG_ID> --source-id <SOURCE_ID> --restore scripts/migrations/backups/<file>.json --apply
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

import feedparser
import httpx
from google.cloud import firestore
from google.cloud.firestore_v1.async_transaction import async_transactional

from app.config import settings
from app.core import url_safety
from app.core.pipeline_constants import MAX_SOURCE_RESPONSE_BYTES, SOURCE_FETCH_TIMEOUT_SECONDS
from app.schemas.pipeline import RSS_TITLE_FORMAT_COMPANY_COLON_TITLE, SourceType
from app.services import job_scout_service as svc
from app.services.firestore_service import get_db, leads_repo, now_utc, pipeline_configs_repo

TARGET_FORMAT = RSS_TITLE_FORMAT_COMPANY_COLON_TITLE
BACKUP_DIR = Path(__file__).resolve().parent / "backups"

# Plan kinds
DIRECT = "DIRECTO"
FEED = "FEED"
MANUAL = "REVISIÓN MANUAL"
SKIPPED = "OMITIDO"

# Restore kinds
RESTORE = "RESTAURAR"
UNCHANGED = "SIN CAMBIO"
CONFLICT = "CONFLICTO"
MISSING = "NO EXISTE"
FOREIGN = "NO PERTENECE"

# Outcomes of a guarded (transactional) write
WRITTEN = "written"
CHANGED = "changed"
GONE = "gone"

FIELDS = ("job_title", "company_name", "fingerprint")
APPLIED_FIELDS = FIELDS + ("raw_title",)
BACKUP_ROW_KEYS = {"id", "original", "applied"}

EXIT_OK, EXIT_ERRORS, EXIT_REFUSED = 0, 1, 2


def say(message: str = "") -> None:
    """Every line goes out the moment it happens, not buffered to the end."""
    print(message, flush=True)


@dataclass
class Plan:
    kind: str
    reason: str = ""
    raw_title: Optional[str] = None
    job_title: Optional[str] = None
    company_name: Optional[str] = None
    fingerprint: Optional[str] = None

    @property
    def writes(self) -> bool:
        return self.kind in (DIRECT, FEED)

    def update_data(self) -> Dict[str, Any]:
        return {
            "raw_title": self.raw_title,
            "job_title": self.job_title,
            "company_name": self.company_name,
            "fingerprint": self.fingerprint,
        }


def plan_lead(lead: Dict[str, Any], feed_titles: Optional[Dict[str, str]]) -> Plan:
    """Decide what to do with one lead. Pure — no I/O. `feed_titles` maps
    job_url -> original entry title, or is None if the feed couldn't be read."""
    if lead.get("raw_title"):
        return Plan(SKIPPED, "ya tiene raw_title")

    stored_title = lead.get("job_title") or ""
    stored_company = lead.get("company_name") or ""

    if not stored_company.strip():
        kind, raw_title = DIRECT, stored_title
    else:
        if feed_titles is None:
            return Plan(MANUAL, "no se pudo leer el feed")
        raw_title = feed_titles.get(lead.get("job_url") or "")
        if raw_title is None:
            return Plan(MANUAL, "la oferta ya no está en el feed")
        kind = FEED

    if not raw_title.strip():
        return Plan(MANUAL, "título vacío")
    if svc._legacy_split_rss_title(raw_title) != (stored_title, stored_company):
        return Plan(MANUAL, f"comprobación cruzada falló: {raw_title!r} no da el job_title/company_name guardados")
    if svc._legacy_rss_fingerprint(raw_title) != lead.get("fingerprint"):
        return Plan(MANUAL, "comprobación cruzada falló: la huella guardada no coincide")

    job_title, company_name = svc._split_rss_title(raw_title, TARGET_FORMAT)
    return Plan(
        kind,
        reason="" if company_name else "sin separador ': ', la empresa queda vacía",
        raw_title=raw_title,
        job_title=job_title,
        company_name=company_name,
        fingerprint=svc.compute_fingerprint(company_name, job_title),
    )


def original_values(lead: Dict[str, Any]) -> Dict[str, Any]:
    return {field: lead.get(field) for field in FIELDS}


def _matches(current: Dict[str, Any], expected: Dict[str, Any]) -> bool:
    """A missing field reads as None, so {"raw_title": None} means "absent"."""
    return all(current.get(field) == value for field, value in expected.items())


def ownership(config_id: str, source_id: str) -> Dict[str, str]:
    """Fields every write also requires, so the script can never touch a lead
    of another config/source — not even from a hand-edited backup."""
    return {"pipeline_config_id": config_id, "source_id": source_id}


def classify_restore(
    current: Optional[Dict[str, Any]], row: Dict[str, Any], owner: Dict[str, str],
) -> str:
    """Pure. What --restore should do with one backup row, given the lead as
    it is now (None if deleted) and the config/source it must belong to."""
    if current is None:
        return MISSING
    if not _matches(current, owner):
        return FOREIGN
    if _matches(current, row["applied"]):
        return RESTORE
    if _matches(current, {**row["original"], "raw_title": None}):
        return UNCHANGED
    return CONFLICT


def restore_data(row: Dict[str, Any]) -> Dict[str, Any]:
    return {**row["original"], "raw_title": firestore.DELETE_FIELD}


# ── Firestore I/O (patched out in tests) ─────────────────────────────────────

async def _guarded_update(transaction, ref, expected: Dict[str, Any], data: Dict[str, Any]) -> str:
    """Body of the per-lead transaction: re-read the lead and write `data`
    (+ updatedAt, same convention as leads_repo.update) only if it still
    matches `expected`. Partial update — every other field is left as is."""
    snap = await ref.get(transaction=transaction)
    if not snap.exists:
        return GONE
    if not _matches(snap.to_dict() or {}, expected):
        return CHANGED
    transaction.update(ref, {**data, "updatedAt": now_utc()})
    return WRITTEN


async def guarded_update(lead_id: str, expected: Dict[str, Any], data: Dict[str, Any]) -> str:
    db = get_db()
    ref = db.collection(leads_repo.collection).document(lead_id)
    return await async_transactional(_guarded_update)(db.transaction(), ref, expected, data)


async def stream_source_leads(config_id: str, source_id: str) -> AsyncIterator[Dict[str, Any]]:
    query = (
        get_db().collection(leads_repo.collection)
        .where(filter=firestore.FieldFilter("pipeline_config_id", "==", config_id))
        .where(filter=firestore.FieldFilter("source_id", "==", source_id))
    )
    async for snap in query.stream():
        yield {**(snap.to_dict() or {}), "id": snap.id}


async def fetch_feed_titles(feed_url: str) -> Dict[str, str]:
    """Read-only: job_url -> entry title, from the feed as it is right now."""
    async with httpx.AsyncClient(timeout=SOURCE_FETCH_TIMEOUT_SECONDS) as client:
        status_code, body = await url_safety.safe_get_bytes(
            client, feed_url, max_bytes=MAX_SOURCE_RESPONSE_BYTES,
        )
    if status_code >= 400:
        raise ValueError(f"HTTP {status_code}")
    parsed = await asyncio.to_thread(feedparser.parse, body)
    return {
        svc._sanitize_job_url(getattr(entry, "link", "") or ""): (getattr(entry, "title", "") or "").strip()
        for entry in getattr(parsed, "entries", []) or []
    }


def write_backup(config_id: str, to_write: List[tuple], only: Optional[str] = None) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    suffix = f"-only-{only}" if only else ""
    path = BACKUP_DIR / f"fix_rss_lead_titles-{config_id}-{stamp}{suffix}.json"
    rows = [
        {"id": lead["id"], "original": original_values(lead), "applied": plan.update_data()}
        for lead, plan in to_write
    ]
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _fp(value: Optional[str]) -> str:
    return (value or "")[:10] + "…"


def _header(mode_apply: bool) -> None:
    mode = "APLICAR (escribe en Firestore)" if mode_apply else "SIMULACIÓN (no escribe)"
    say(f"Proyecto: {settings.google_cloud_project or '(default ADC)'} · base: {settings.firestore_database} · MODO: {mode}")


def _confirm(prompt: str) -> bool:
    return input(prompt).strip().lower() == "yes"


# ── Fix ──────────────────────────────────────────────────────────────────────

async def run(config_id: str, source_id: str, apply: bool, only: Optional[str] = None) -> Dict[str, Any]:
    """`only`: process (and, with apply, back up and write) just that lead.
    Refused if it isn't in the plan (not a lead of this source, or in
    REVISIÓN MANUAL / OMITIDO)."""
    _header(apply)

    config = await pipeline_configs_repo.get(config_id)
    source = next((s for s in (config or {}).get("sources") or [] if s.get("id") == source_id), None)
    if not source or source.get("source_type") != SourceType.RSS.value:
        say(f"ERROR: no hay una fuente RSS {source_id} en el config {config_id}. No se hizo nada.")
        return {"refused": True}
    source_config = source.get("config") or {}
    title_format = source_config.get("title_format")
    say(f"Config {config_id} · fuente {source_id} {source.get('name')!r} · title_format={title_format!r}")
    if only:
        say(f"--only {only}: solo se procesa este lead (los duplicados no se evalúan)")

    format_ready = title_format == TARGET_FORMAT
    if apply and not format_ready:
        say(f"ERROR: --apply rechazado. La fuente tiene title_format={title_format!r}; configúrala primero "
            f"con {TARGET_FORMAT!r} (Configuración → Pipeline). No se escribió nada.")
        return {"refused": True}
    if not format_ready:
        say(f"AVISO: la fuente aún no tiene title_format={TARGET_FORMAT!r}; --apply se negará a correr hasta que lo tenga.")

    feed_titles: Optional[Dict[str, str]]
    try:
        feed_titles = await fetch_feed_titles(source_config.get("feed_url") or "")
        say(f"Feed leído (solo lectura): {len(feed_titles)} entradas")
    except Exception as exc:
        feed_titles = None
        say(f"AVISO: no se pudo leer el feed ({exc}); los leads que lo necesiten irán a REVISIÓN MANUAL")
    say()

    counts = {DIRECT: 0, FEED: 0, MANUAL: 0, SKIPPED: 0}
    to_write: List[tuple] = []
    first_by_fp: Dict[str, Dict[str, Any]] = {}
    groups: Dict[str, List[Dict[str, Any]]] = {}
    read = 0
    only_plan: Optional[Plan] = None

    async for lead in stream_source_leads(config_id, source_id):
        if only and lead["id"] != only:
            continue
        read += 1
        plan = plan_lead(lead, feed_titles)
        only_plan = plan
        counts[plan.kind] += 1
        prefix = f"[{read}] lead {lead['id']}"
        if plan.writes:
            tag = "[pendiente de --apply]" if apply else "[simulado]"
            origin = "título guardado" if plan.kind == DIRECT else "título recuperado del feed"
            say(f"{prefix}  {plan.kind}  {origin}: {plan.raw_title!r}")
            say(f"      → empresa={plan.company_name!r}  cargo={plan.job_title!r}  "
                f"huella {_fp(lead.get('fingerprint'))} → {_fp(plan.fingerprint)}  {tag}")
            if plan.reason:
                say(f"      nota: {plan.reason}")
            to_write.append((lead, plan))
        else:
            say(f"{prefix}  {plan.kind}: {plan.reason}  (no se toca)")

        final_fp = plan.fingerprint if plan.writes else lead.get("fingerprint")
        if final_fp:
            groups.setdefault(final_fp, []).append(lead)
            if final_fp in first_by_fp:
                say(f"      ↳ DUPLICADO de {first_by_fp[final_fp]['id']} (misma huella final)")
            else:
                first_by_fp[final_fp] = lead

    if only and not to_write:
        why = ("no es un lead de esta fuente" if only_plan is None
               else f"está como {only_plan.kind} ({only_plan.reason})")
        say(f"\nERROR: --only {only} rechazado: no está en el plan, {why}. No se escribió nada.")
        return {"refused": True}

    dup_groups = [members for members in groups.values() if len(members) > 1]
    dup_extra = sum(len(members) - 1 for members in dup_groups)
    if dup_groups:
        say("\nDuplicados (solo se reportan, no se borra ni se marca nada):")
        for number, members in enumerate(dup_groups, 1):
            ordered = sorted(members, key=lambda m: str(m.get("createdAt") or ""))
            say(f"  Grupo {number}:")
            for index, member in enumerate(ordered):
                oldest = "  ← más antiguo" if index == 0 else ""
                say(f"    {member['id']}  createdAt={member.get('createdAt')}  status={member.get('status')}  "
                    f"run={member.get('pipeline_run_id')}{oldest}")

    summary = {
        "read": read,
        "direct": counts[DIRECT],
        "feed": counts[FEED],
        "manual": counts[MANUAL],
        "skipped": counts[SKIPPED],
        "duplicate_groups": len(dup_groups),
        "duplicate_extra_docs": dup_extra,
        "written": 0,
        "errors": 0,
        "changed": 0,
        "only": only,
    }
    scope = f" (--only: solo el lead {only})" if only else ""
    say(f"\nResumen{scope}: {read} leídos = {counts[DIRECT]} directos + {counts[FEED]} recuperados del feed + "
        f"{counts[MANUAL]} revisión manual + {counts[SKIPPED]} omitidos · "
        f"duplicados: {dup_extra} documento(s) sobrante(s) en {len(dup_groups)} grupo(s)")

    if not apply:
        say("\nSimulación: no se escribió nada. Para aplicar, vuelve a correr con --apply.")
        return summary
    if not to_write:
        say("\nNada que escribir.")
        return summary

    backup_path = write_backup(config_id, to_write, only)
    say(f"\nRespaldo de {len(to_write)} lead(s){scope} guardado en {backup_path}")

    if not _confirm(f"Escribe 'yes' para actualizar {len(to_write)} lead(s): "):
        say("Cancelado. No se escribió nada.")
        return summary

    for lead, plan in to_write:
        expected = {**original_values(lead), "raw_title": None, **ownership(config_id, source_id)}
        try:
            outcome = await guarded_update(lead["id"], expected, plan.update_data())
        except Exception as exc:
            summary["errors"] += 1
            say(f"  lead {lead['id']}  ERROR al escribir: {exc}")
            continue
        if outcome == WRITTEN:
            summary["written"] += 1
            say(f"  lead {lead['id']}  [escrito]")
        else:
            summary["changed"] += 1
            detail = "ya no existe" if outcome == GONE else "no se toca"
            say(f"  lead {lead['id']}  CAMBIÓ DESDE LA LECTURA: {detail}")

    not_planned = counts[MANUAL] + counts[SKIPPED]
    say(f"\nResultado{scope}: {summary['written']} escritos · {summary['errors']} con error · "
        f"{summary['changed']} cambió desde la lectura · {not_planned} omitidos "
        f"({counts[MANUAL]} revisión manual + {counts[SKIPPED]} ya tenían raw_title)")
    return summary


# ── Restore ──────────────────────────────────────────────────────────────────

def _check_fields(row_no: int, part: str, value: Any, fields: tuple) -> None:
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError(f"fila {row_no}: '{part}' debe tener exactamente {list(fields)}")
    for field in fields:
        if not isinstance(value[field], str):
            raise ValueError(f"fila {row_no}: '{part}.{field}' debe ser texto")


def load_backup(path: Path) -> List[Dict[str, Any]]:
    """Strict: the whole file is rejected if any row isn't exactly what
    write_backup produces — `id` (non-empty text), `original` with exactly
    FIELDS and `applied` with exactly APPLIED_FIELDS, all values text, no
    repeated ids. A hand-edited backup can't add fields to a write."""
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not rows:
        raise ValueError("el respaldo debe ser una lista no vacía de filas")
    seen = set()
    for row_no, row in enumerate(rows, 1):
        if not isinstance(row, dict) or set(row) != BACKUP_ROW_KEYS:
            raise ValueError(f"fila {row_no}: debe tener exactamente {sorted(BACKUP_ROW_KEYS)}")
        if not isinstance(row["id"], str) or not row["id"]:
            raise ValueError(f"fila {row_no}: 'id' debe ser texto no vacío")
        if row["id"] in seen:
            raise ValueError(f"fila {row_no}: id repetido {row['id']!r}")
        seen.add(row["id"])
        _check_fields(row_no, "original", row["original"], FIELDS)
        _check_fields(row_no, "applied", row["applied"], APPLIED_FIELDS)
    return rows


def _diff(current: Dict[str, Any], expected: Dict[str, Any]) -> str:
    return ", ".join(
        f"{field}={current.get(field)!r}" for field, value in expected.items() if current.get(field) != value
    )


async def run_restore(backup_path: Path, apply: bool, config_id: str, source_id: str) -> Dict[str, Any]:
    _header(apply)
    try:
        rows = load_backup(backup_path)
    except Exception as exc:
        say(f"ERROR: respaldo no válido {backup_path}: {exc}. No se hizo nada.")
        return {"refused": True}
    owner = ownership(config_id, source_id)
    say(f"Respaldo {backup_path}: {len(rows)} lead(s) · solo leads de config {config_id} / fuente {source_id}\n")

    counts = {RESTORE: 0, UNCHANGED: 0, CONFLICT: 0, MISSING: 0, FOREIGN: 0}
    to_restore: List[Dict[str, Any]] = []
    for index, row in enumerate(rows, 1):
        current = await leads_repo.get(row["id"])
        kind = classify_restore(current, row, owner)
        counts[kind] += 1
        prefix = f"[{index}] lead {row['id']}  {kind}"
        if kind == RESTORE:
            tag = "[pendiente de --apply]" if apply else "[simulado]"
            original = row["original"]
            say(f"{prefix}  → empresa={original['company_name']!r}  cargo={original['job_title']!r}  "
                f"huella → {_fp(original['fingerprint'])}  raw_title se elimina  {tag}")
            to_restore.append(row)
        elif kind == CONFLICT:
            say(f"{prefix}: difiere de lo aplicado y del original ({_diff(current, row['applied'])})  (no se toca)")
        elif kind == FOREIGN:
            say(f"{prefix}: es de otra config/fuente ({_diff(current, owner)})  (no se toca)")
        else:
            say(f"{prefix}  (no se toca)")

    summary = {
        "rows": len(rows),
        "to_restore": counts[RESTORE],
        "unchanged": counts[UNCHANGED],
        "conflicts": counts[CONFLICT],
        "missing": counts[MISSING],
        "foreign": counts[FOREIGN],
        "restored": 0,
        "errors": 0,
        "changed": 0,
    }
    say(f"\nResumen: {len(rows)} en el respaldo = {counts[RESTORE]} a restaurar + {counts[UNCHANGED]} sin cambio + "
        f"{counts[CONFLICT]} conflicto + {counts[MISSING]} no existe + {counts[FOREIGN]} no pertenece")

    if not apply:
        say("\nSimulación: no se escribió nada. Para restaurar, vuelve a correr con --apply.")
        return summary
    if not to_restore:
        say("\nNada que restaurar.")
        return summary
    if not _confirm(f"Escribe 'yes' para restaurar {len(to_restore)} lead(s): "):
        say("Cancelado. No se escribió nada.")
        return summary

    for row in to_restore:
        try:
            outcome = await guarded_update(row["id"], {**row["applied"], **owner}, restore_data(row))
        except Exception as exc:
            summary["errors"] += 1
            say(f"  lead {row['id']}  ERROR al restaurar: {exc}")
            continue
        if outcome == WRITTEN:
            summary["restored"] += 1
            say(f"  lead {row['id']}  [restaurado]")
        else:
            summary["changed"] += 1
            detail = "ya no existe" if outcome == GONE else "no se toca"
            say(f"  lead {row['id']}  CAMBIÓ DESDE LA LECTURA: {detail}")

    not_planned = counts[UNCHANGED] + counts[CONFLICT] + counts[MISSING] + counts[FOREIGN]
    say(f"\nResultado: {summary['restored']} restaurados · {summary['errors']} con error · "
        f"{summary['changed']} cambió desde la lectura · {not_planned} omitidos "
        f"({counts[UNCHANGED]} sin cambio + {counts[CONFLICT]} conflicto + {counts[MISSING]} no existe + "
        f"{counts[FOREIGN]} no pertenece)")
    return summary


# ── CLI ──────────────────────────────────────────────────────────────────────

def exit_code(summary: Dict[str, Any]) -> int:
    if summary.get("refused"):
        return EXIT_REFUSED
    if summary.get("errors"):
        return EXIT_ERRORS
    return EXIT_OK


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config-id", help="id del pipeline_config (== userId del dueño)")
    parser.add_argument("--source-id", help="id de la fuente RSS dentro de ese config")
    parser.add_argument("--restore", type=Path, metavar="BACKUP_JSON",
                        help="Deshace un --apply a partir de su respaldo (simula salvo que se pase --apply)")
    parser.add_argument("--only", metavar="LEAD_ID",
                        help="Procesa (y con --apply, respalda y escribe) solo ese lead")
    parser.add_argument("--apply", action="store_true", help="Escribe los cambios (sin esto, solo simula)")
    args = parser.parse_args(argv)
    if not (args.config_id and args.source_id):
        parser.error("hacen falta --config-id y --source-id (también con --restore)")
    if args.restore and args.only:
        parser.error("--restore no se combina con --only")
    return args


async def main(args: argparse.Namespace) -> int:
    if args.restore:
        summary = await run_restore(args.restore, args.apply, args.config_id, args.source_id)
    else:
        summary = await run(args.config_id, args.source_id, args.apply, only=args.only)
    return exit_code(summary)


if __name__ == "__main__":
    sys.exit(asyncio.run(main(parse_args())))
