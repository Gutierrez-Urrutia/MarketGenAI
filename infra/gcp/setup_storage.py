"""Crea el bucket de archivos generados (privado) y da permisos a la API y al worker. Repetible.

Los archivos se entregan con URLs firmadas con vencimiento; el bucket nunca es público.
Uso: python infra/gcp/setup_storage.py   (con GCLOUD=ruta a gcloud si no está en el PATH)
"""
import json, os, subprocess, sys, tempfile

G = os.environ.get("GCLOUD", "gcloud")  # en Windows: ruta completa a gcloud.cmd
PROJECT, REGION = "marketgen-dev", "us-central1"
BUCKET = "marketgen-dev-assets"
SERVICE_ACCOUNTS = [f"marketgen-api@{PROJECT}.iam.gserviceaccount.com", f"marketgen-worker@{PROJECT}.iam.gserviceaccount.com"]
# Orígenes que pueden pedir los archivos desde el navegador (por si el frontend los descarga con fetch).
CORS_ORIGINS = ["http://localhost:5173", "https://marketgen-web-156520322318.us-central1.run.app", "https://marketgen-web-6p37vzknka-uc.a.run.app"]


def gc(*args, tolerate=None):
    r = subprocess.run([G, *args, f"--project={PROJECT}"], capture_output=True)
    out = (r.stdout + r.stderr).decode("utf-8", "replace")
    if r.returncode != 0 and not (tolerate and tolerate in out):
        print("ERROR:", " ".join(args[:4]), "->", out.strip().splitlines()[-1][:240])
        sys.exit(1)
    return out


out = gc("storage", "buckets", "create", f"gs://{BUCKET}", f"--location={REGION}", "--uniform-bucket-level-access",
         "--public-access-prevention", tolerate="already exists")
print("bucket:", BUCKET, "(ya existía)" if "already exists" in out else "(creado, privado)")

for sa in SERVICE_ACCOUNTS:
    gc("storage", "buckets", "add-iam-policy-binding", f"gs://{BUCKET}", f"--member=serviceAccount:{sa}", "--role=roles/storage.objectAdmin")
    # Para firmar URLs, la cuenta se firma a sí misma por la API IAM.
    gc("iam", "service-accounts", "add-iam-policy-binding", sa, f"--member=serviceAccount:{sa}", "--role=roles/iam.serviceAccountTokenCreator")
    print("permisos:", sa)

cors = [{"origin": CORS_ORIGINS, "method": ["GET", "HEAD"], "responseHeader": ["Content-Type", "Content-Disposition"], "maxAgeSeconds": 3600}]
fd, path = tempfile.mkstemp(suffix=".json")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(cors, f)
gc("storage", "buckets", "update", f"gs://{BUCKET}", f"--cors-file={path}")
os.remove(path)
print("CORS del bucket configurado")
