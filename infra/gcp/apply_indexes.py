"""Aplica en marketgen-dev los índices compuestos de backend/firestore.indexes.json (los de auditLogs).

    python infra/gcp/apply_indexes.py

- Repetible: un índice que ya existe se salta. Solo CREA índices; si se borra uno del JSON no se elimina de Firestore.
- No espera a que Firestore termine de construirlos (`--async`): hacerlo tarda varios minutos y la app funciona mientras
  tanto con su camino lento (AuditLogsRepo.search). El CI lo corre solo cuando cambia el archivo de índices.
- Sale con código 1 si algún índice no se pudo pedir (el CI lo marca como aviso, no tumba el despliegue).

En Windows define GCLOUD con la ruta a gcloud.cmd (se usa el Python incluido en el SDK para evitar que cmd.exe rompa
los argumentos).
"""
import json
import os
import subprocess
import sys

PROJECT = "marketgen-dev"
SOURCE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend", "firestore.indexes.json")

_gcloud = os.environ.get("GCLOUD", "gcloud")
if _gcloud.lower().endswith("gcloud.cmd"):
    sdk = os.path.dirname(os.path.dirname(_gcloud))
    G = [os.path.join(sdk, "platform", "bundledpython", "python.exe"), os.path.join(sdk, "lib", "gcloud.py")]
else:
    G = [_gcloud]


def request(index) -> str:
    """Pide un índice: 'creado', 'ya existe' o 'error: ...'."""
    args = ["firestore", "indexes", "composite", "create", "--async",
            f"--collection-group={index['collectionGroup']}", f"--query-scope={index['queryScope'].lower()}"]
    args += [f"--field-config=field-path={f['fieldPath']},order={f['order'].lower()}" for f in index["fields"]]
    r = subprocess.run([*G, *args, f"--project={PROJECT}", "--quiet"], capture_output=True)
    out = (r.stdout + r.stderr).decode("utf-8", "replace")
    if r.returncode == 0:
        return "creado (se construye en segundo plano)"
    if "already exists" in out.lower():
        return "ya existe"
    return "error: " + (out.strip().splitlines() or ["sin detalle"])[-1][:200]


def main() -> int:
    with open(SOURCE, encoding="utf-8") as fh:
        indexes = json.load(fh)["indexes"]
    failed = 0
    for index in indexes:
        label = f"{index['collectionGroup']}: " + " + ".join(f"{f['fieldPath']} {f['order'][:4].lower()}" for f in index["fields"])
        result = request(index)
        failed += result.startswith("error")
        print(f"{label} -> {result}")
    print(f"\n{len(indexes)} índices en el archivo, {failed} con error.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
