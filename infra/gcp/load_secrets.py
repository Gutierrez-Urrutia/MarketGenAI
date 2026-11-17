"""Crea la cuenta de servicio y carga los secretos en Secret Manager (marketgen-dev). Nunca imprime valores."""
import os, secrets, subprocess, sys
from cryptography.fernet import Fernet

G = os.environ.get("GCLOUD", "gcloud")  # en Windows: ruta completa a gcloud.cmd
PROJECT = "marketgen-dev"
SA_NAME = "marketgen-api"
SA = f"{SA_NAME}@{PROJECT}.iam.gserviceaccount.com"
ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend", ".env")


def gc(*args, data=None, ok_if=None):
    r = subprocess.run([G, *args, f"--project={PROJECT}"], input=data, capture_output=True)
    out = (r.stdout + r.stderr).decode("utf-8", "replace")
    if r.returncode != 0 and not (ok_if and ok_if in out):
        print("ERROR:", " ".join(args[:3]), "->", out.strip().splitlines()[-1][:200])
        sys.exit(1)
    return r.returncode, out


env = {}
for line in open(ENV, encoding="utf-8"):
    line = line.rstrip("\n")
    if line.strip() and not line.lstrip().startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")

# secreto -> valor (los de .env se copian; los demás son nuevos y solo viven en Secret Manager)
SECRETS = {
    "app-secret-key": secrets.token_urlsafe(48),
    "local-dev-auth-password": secrets.token_urlsafe(18),
    "pipeline-encryption-key": Fernet.generate_key().decode(),
    "deepseek-api-key": env.get("DEEPSEEK_API_KEY", ""),
    "gemini-api-key": env.get("GEMINI_API_KEY", ""),
    "google-api-key": env.get("GOOGLE_API_KEY", ""),
    "supabase-service-key": env.get("SUPABASE_SERVICE_KEY", ""),
    "google-oauth-client-secret": env.get("GOOGLE_OAUTH_CLIENT_SECRET", ""),
}

# cuenta de servicio de la API
rc, out = gc("iam", "service-accounts", "create", SA_NAME, "--display-name=MarketGen API dev", ok_if="already exists")
print("cuenta de servicio:", "ya existía" if "already exists" in out else "creada", SA)
for role in ("roles/datastore.user", "roles/secretmanager.secretAccessor"):
    gc("projects", "add-iam-policy-binding", PROJECT, f"--member=serviceAccount:{SA}", f"--role={role}", "--condition=None", "--quiet")
    print("rol asignado:", role)

for name, value in SECRETS.items():
    if not value:
        print(f"saltado (vacío en .env): {name}")
        continue
    rc, out = gc("secrets", "describe", name, ok_if="NOT_FOUND")
    if rc != 0:
        gc("secrets", "create", name, "--replication-policy=automatic")
    gc("secrets", "versions", "add", name, "--data-file=-", data=value.encode("utf-8"))
    print(f"secreto cargado: {name} ({len(value)} caracteres)")

rc, out = gc("secrets", "list", "--format=value(name.basename())")
print("secretos en el proyecto:", ", ".join(out.split()))
