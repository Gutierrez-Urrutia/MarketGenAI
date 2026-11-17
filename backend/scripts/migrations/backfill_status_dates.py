"""One-off backfill: fecha de cada cambio de estado de las propuestas (RF-VTA-10).

Contexto: desde RF-VTA-10 cada cambio de estado guarda `statusDates.<estado>` en la propuesta, y el
reporte calcula el tiempo de cierre con `statusDates.firmada`. Las propuestas que se firmaron antes
no tienen ese campo, pero el cambio quedó en el registro de auditoría (`auditLogs`, acción
`proposal_status_changed`). Este script copia de ahí la fecha del último cambio a cada estado.

Reglas:
  - Solo escribe `statusDates.<estado>` que la propuesta todavía no tiene (nunca pisa uno existente).
  - No borra nada ni toca otros campos.
  - Sin registro de auditoría para el cambio, la propuesta queda como estaba (el reporte la cuenta
    como «firmada sin fecha de cierre»).

Uso (desde backend/, con el venv activo):

    python -m scripts.migrations.backfill_status_dates            # simulacro: solo informa
    python -m scripts.migrations.backfill_status_dates --apply    # escribe
"""
from __future__ import annotations

import argparse
import asyncio
from typing import Any, Dict, List

from app.services.firestore_service import get_db, ProposalsRepo

ACTION = "proposal_status_changed"


def plan_updates(proposal: Dict[str, Any], logs: List[Dict[str, Any]]) -> Dict[str, str]:
    """Pura. Fechas a escribir: último cambio a cada estado según la auditoría, salvo las que la propuesta ya tiene."""
    existing = proposal.get("statusDates") or {}
    latest: Dict[str, str] = {}
    for log in logs:
        state, when = log.get("newStatus"), log.get("timestamp")
        if state and when and (state not in latest or str(when) > latest[state]):
            latest[state] = str(when)
    return {f"statusDates.{state}": when for state, when in latest.items() if state not in existing}


async def run(apply: bool) -> None:
    db = get_db()
    logs_by_proposal: Dict[str, List[Dict[str, Any]]] = {}
    for snap in await db.collection(ProposalsRepo.audit_collection).where("action", "==", ACTION).get():
        log = snap.to_dict() or {}
        if log.get("proposalId"):
            logs_by_proposal.setdefault(log["proposalId"], []).append(log)

    proposals = await db.collection("proposals").get()
    to_update, untouched = [], 0
    for snap in proposals:
        updates = plan_updates(snap.to_dict() or {}, logs_by_proposal.get(snap.id, []))
        if updates:
            to_update.append((snap.reference, snap.id, updates))
        else:
            untouched += 1

    print(f"Propuestas: {len(proposals)} · con fechas por completar: {len(to_update)} · sin cambios: {untouched}")
    for _ref, pid, updates in to_update[:20]:
        print(f"  {pid}: {', '.join(k.split('.', 1)[1] for k in updates)}")
    if not apply:
        print("Simulacro: no se escribió nada. Usa --apply para guardar.")
        return
    for ref, _pid, updates in to_update:
        await ref.update(updates)
    print(f"Listo: {len(to_update)} propuestas actualizadas.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="escribe los cambios (sin esto solo informa)")
    asyncio.run(run(parser.parse_args().apply))
