"""One-off backfill: assign `userId` to legacy Firestore documents.

Context: documents created before the per-user ownership filter was added
(see CLAUDE.md "Reglas que SIEMPRE debes seguir" #1-2) don't have a `userId`
field. `_assert_owner` / `_get_X_for_user` then reject them with 403.

This script:
  1. Lists how many documents are missing `userId` per collection.
  2. Asks for confirmation.
  3. Sets `userId` ONLY on documents that don't already have it
     (existing `userId` values are never touched or overwritten).

It never deletes documents or fields.

Usage (from backend/, with the venv active so app.* imports resolve):

    # Dry run (default) - only lists orphans, writes nothing
    python -m scripts.migrations.backfill_user_id --email you@example.com

    # Apply the backfill
    python -m scripts.migrations.backfill_user_id --email you@example.com --apply

You can pass --user-id <SUB> directly instead of --email if you already
know your Firestore `users/{id}` document id (== JWT `sub` claim).
"""
from __future__ import annotations

import argparse
import asyncio

from app.config import settings
from app.services.firestore_service import get_db, users_repo

# Collections where ownership is enforced via a top-level `userId` field
# (see grep for `userId` across app/routers). The `books/{id}/chapters`
# sub-collection is intentionally excluded: ownership is inherited from
# the parent book, chapters have no `userId` of their own.
DEFAULT_COLLECTIONS = ["proposals", "books", "customers", "templates", "assets", "jobs"]


async def find_orphans(db, collection: str) -> list:
    """Return doc snapshots in `collection` that have no (truthy) `userId`."""
    query = db.collection(collection).select(["userId", "isPublic"])
    docs = await query.get()
    return [snap for snap in docs if snap.exists and not (snap.to_dict() or {}).get("userId")]


async def resolve_user_id(args: argparse.Namespace) -> str:
    if args.email:
        user = await users_repo.get_by_email(args.email)
        if not user:
            raise SystemExit(f"No se encontro ningun usuario con email '{args.email}' en Firestore.")
        print(f"Usuario encontrado: {user['email']} -> userId = {user['id']}")
        return user["id"]

    # --user-id was given: best-effort sanity check against the users collection.
    user = await users_repo.get(args.user_id)
    if user:
        print(f"userId '{args.user_id}' corresponde a {user.get('email', '(sin email)')}")
    else:
        print(f"AVISO: no se encontro un documento users/{args.user_id}. Verifica que el id sea correcto.")
    return args.user_id


async def main(args: argparse.Namespace) -> None:
    db = get_db()
    print(f"Proyecto Firestore: {settings.google_cloud_project or '(default ADC)'}  "
          f"DB: {settings.firestore_database}\n")

    user_id = await resolve_user_id(args)

    print(f"\nBuscando documentos sin 'userId' en: {', '.join(args.collections)}\n")

    pending: dict[str, list] = {}
    for collection in args.collections:
        orphans = await find_orphans(db, collection)

        if collection == "templates" and not args.include_public_templates:
            without_public = []
            skipped_public = 0
            for snap in orphans:
                if (snap.to_dict() or {}).get("isPublic"):
                    skipped_public += 1
                else:
                    without_public.append(snap)
            orphans = without_public
            if skipped_public:
                print(f"  - templates: {skipped_public} plantilla(s) publica(s) sin userId "
                      f"(omitidas; usa --include-public-templates para incluirlas)")

        pending[collection] = orphans
        print(f"  - {collection}: {len(orphans)} documento(s) sin userId")
        for snap in orphans[:5]:
            print(f"      · {snap.id}")
        if len(orphans) > 5:
            print(f"      · ... y {len(orphans) - 5} mas")

    total = sum(len(snaps) for snaps in pending.values())
    if total == 0:
        print("\nNo hay documentos huerfanos. Nada que hacer.")
        return

    print(f"\nSe asignara userId = '{user_id}' a {total} documento(s) en total.")

    if not args.apply:
        print("\n(dry-run: no se escribio nada. Vuelve a ejecutar con --apply para aplicar los cambios)")
        return

    if not args.yes:
        answer = input("\nEscribe 'yes' para continuar: ").strip().lower()
        if answer != "yes":
            print("Cancelado. No se modifico nada.")
            return

    for collection, snaps in pending.items():
        for snap in snaps:
            await snap.reference.update({"userId": user_id})
        if snaps:
            print(f"  - {collection}: {len(snaps)} documento(s) actualizados")

    print("\nListo. Ningun documento existente con userId fue modificado.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--user-id", help="userId (sub / users/{id}) a asignar a los documentos huerfanos")
    target.add_argument("--email", help="Email del usuario; se busca su userId en la coleccion 'users'")
    parser.add_argument(
        "--collections", nargs="+", default=DEFAULT_COLLECTIONS,
        help=f"Colecciones a revisar (default: {DEFAULT_COLLECTIONS})",
    )
    parser.add_argument("--apply", action="store_true", help="Aplica los cambios (sin esto, solo hace dry-run)")
    parser.add_argument("--yes", action="store_true", help="No pedir confirmacion interactiva antes de aplicar")
    parser.add_argument(
        "--include-public-templates", action="store_true",
        help="Tambien asigna userId a templates con isPublic=true (por defecto se omiten)",
    )
    return parser.parse_args()


if __name__ == "__main__":
    asyncio.run(main(parse_args()))
