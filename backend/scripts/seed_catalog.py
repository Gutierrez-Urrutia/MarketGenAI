"""Manual, idempotent seed for the service catalog (RF-VTA-02).

Loads the 7 provisional service types if they do not exist. With `--demo` it
also loads the 4 provisional services from `catalogo_provisorio.json`. The data
is provisional until NoonDalton confirms the real catalog. Nothing is updated or
deleted: anything that already exists (same normalized name / name+unit) is skipped.

Usage (from backend/, with the venv active so app.* imports resolve):

    python -m scripts.seed_catalog
    python -m scripts.seed_catalog --demo
    python -m scripts.seed_catalog --demo --demo-file path/to/catalogo_provisorio.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from app.services.firestore_service import (
    DuplicateKeyError,
    UniqueKeyedRepo,
    service_catalog_repo,
    service_types_repo,
)

SEED_USER = "seed_catalog"

DEFAULT_TYPES = [
    "Atención al cliente y mesa de ayuda",
    "Soporte técnico",
    "Back office",
    "Cobranza",
    "Ventas y telemarketing",
    "Ciberseguridad",
    "Otros",
]

DEFAULT_DEMO_FILE = Path(
    r"C:\Users\saave\Documents\TEMPORAL-UNIR-CASOS-RF04\RF-VTA-02_Pruebas_y_Aceptacion"
    r"\Datos_de_prueba\catalogo_provisorio.json"
)


async def seed_types() -> dict[str, str]:
    """Create missing types; return {name: id} for every type in DEFAULT_TYPES."""
    ids: dict[str, str] = {}
    for name in DEFAULT_TYPES:
        try:
            created = await service_types_repo.create_unique(
                {"name": name, "active": True, "createdBy": SEED_USER, "updatedBy": SEED_USER},
                UniqueKeyedRepo.make_key(name),
            )
            ids[name] = created["id"]
            print(f"  tipo creado: {name}")
        except DuplicateKeyError:
            print(f"  tipo ya existe, se omite: {name}")
    if len(ids) < len(DEFAULT_TYPES):
        wanted = {UniqueKeyedRepo.make_key(n): n for n in DEFAULT_TYPES}
        for existing in await service_types_repo.list(limit=0):
            name = wanted.get(UniqueKeyedRepo.make_key(existing["name"]))
            if name:
                ids.setdefault(name, existing["id"])
    return ids


async def seed_demo_services(type_ids: dict[str, str], demo_file: Path) -> None:
    data = json.loads(demo_file.read_text(encoding="utf-8"))
    for item in data["servicios"]:
        type_id = type_ids.get(item["tipo"])
        if not type_id:
            print(f"  servicio omitido (tipo desconocido '{item['tipo']}'): {item['nombre']}")
            continue
        try:
            await service_catalog_repo.create_unique(
                {
                    "name": item["nombre"],
                    "description": "",
                    "unit": item["unidad"],
                    "typeId": type_id,
                    "price": item["precio"],
                    "currency": item["moneda"],
                    "conditions": item.get("condiciones", ""),
                    "active": True,
                    "createdBy": SEED_USER,
                    "updatedBy": SEED_USER,
                },
                UniqueKeyedRepo.make_key(item["nombre"], item["unidad"]),
            )
            print(f"  servicio creado: {item['nombre']} / {item['unidad']}")
        except DuplicateKeyError:
            print(f"  servicio ya existe, se omite: {item['nombre']} / {item['unidad']}")


async def main() -> None:
    parser = argparse.ArgumentParser(description="Carga inicial (provisoria) del catálogo de servicios.")
    parser.add_argument("--demo", action="store_true", help="Carga también los servicios de prueba.")
    parser.add_argument("--demo-file", type=Path, default=DEFAULT_DEMO_FILE, help="JSON con los servicios de prueba.")
    args = parser.parse_args()

    print("Tipos de servicio:")
    type_ids = await seed_types()
    if args.demo:
        print("Servicios de prueba:")
        await seed_demo_services(type_ids, args.demo_file)
    print("Listo.")


if __name__ == "__main__":
    asyncio.run(main())
