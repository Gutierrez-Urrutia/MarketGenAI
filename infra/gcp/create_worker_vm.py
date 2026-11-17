"""Crea la VM del worker (Celery + Redis) en marketgen-dev. Es repetible: lo que ya existe se reutiliza.

Qué crea: cuenta de servicio marketgen-worker, IP interna fija, secretos de Redis y la VM e2-small.
Uso: python infra/gcp/create_worker_vm.py   (con GCLOUD=ruta a gcloud si no está en el PATH)
"""
import os, secrets, subprocess, sys, tempfile

G = os.environ.get("GCLOUD", "gcloud")  # en Windows: ruta completa a gcloud.cmd
PROJECT, REGION, ZONE = "marketgen-dev", "us-central1", "us-central1-a"
VM, IP_NAME, IP = "marketgen-worker", "marketgen-worker-ip", "10.128.0.50"
SA_NAME = "marketgen-worker"
SA = f"{SA_NAME}@{PROJECT}.iam.gserviceaccount.com"
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, "..", "..", "backend", ".env")


def gc(*args, data=None, tolerate=None):
    r = subprocess.run([G, *args, f"--project={PROJECT}"], input=data, capture_output=True)
    out = (r.stdout + r.stderr).decode("utf-8", "replace")
    if r.returncode != 0 and not (tolerate and tolerate in out):
        print("ERROR:", " ".join(args[:4]), "->", out.strip().splitlines()[-1][:240])
        sys.exit(1)
    return r.returncode, out


def secret_exists(name):
    return gc("secrets", "describe", name, tolerate="NOT_FOUND")[0] == 0


def put_secret(name, value, overwrite=False):
    if secret_exists(name):
        if not overwrite:
            print(f"secreto ya existe: {name}")
            return
    else:
        gc("secrets", "create", name, "--replication-policy=automatic")
    gc("secrets", "versions", "add", name, "--data-file=-", data=value.encode())
    print(f"secreto cargado: {name}")


# 1) Secretos de Redis. La contraseña solo se genera si no existe, para no romper una VM ya creada.
if not secret_exists("redis-password"):
    password = secrets.token_urlsafe(24)
    put_secret("redis-password", password)
    put_secret("redis-url", f"redis://:{password}@{IP}:6379/0", overwrite=True)
    put_secret("celery-result-backend", f"redis://:{password}@{IP}:6379/1", overwrite=True)
else:
    print("secretos de Redis ya existen")

# 2) Cuenta de servicio de la VM.
_, out = gc("iam", "service-accounts", "create", SA_NAME, "--display-name=MarketGen worker dev", tolerate="already exists")
print("cuenta de servicio:", "ya existía" if "already exists" in out else "creada", SA)
import time
time.sleep(15)  # propagación de la cuenta recién creada
for role in ("roles/secretmanager.secretAccessor", "roles/artifactregistry.reader", "roles/datastore.user", "roles/logging.logWriter"):
    gc("projects", "add-iam-policy-binding", PROJECT, f"--member=serviceAccount:{SA}", f"--role={role}", "--condition=None", "--quiet")
    print("rol asignado:", role)

# 3) IP interna fija (la API la usa para llegar a Redis, aunque la VM se apague y se encienda).
_, out = gc("compute", "addresses", "create", IP_NAME, f"--region={REGION}", "--subnet=default", f"--addresses={IP}", tolerate="already exists")
print("IP interna:", IP, "(ya existía)" if "already exists" in out else "(reservada)")

# 4) Variables no secretas del worker (metadato), desde backend/.env.
env = {}
for line in open(ENV, encoding="utf-8"):
    line = line.rstrip("\n")
    if line.strip() and not line.lstrip().startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
copiar = ["APP_NAME", "GEMINI_DEFAULT_MODEL", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "SUPABASE_URL",
          "SUPABASE_STORAGE_BUCKET", "GOOGLE_OAUTH_CLIENT_ID", "ACCESS_TOKEN_EXPIRE_MINUTES", "REFRESH_TOKEN_EXPIRE_DAYS"]
lines = [f"{k}={env[k]}" for k in copiar if env.get(k)]
lines += ["APP_ENV=production", "APP_DEBUG=false", "LOCAL_DEV_AUTH_ENABLED=false", f"GOOGLE_CLOUD_PROJECT={PROJECT}", "CELERY_CONCURRENCY=2",
          "STORAGE_BACKEND=gcs", "GCS_BUCKET=marketgen-dev-assets"]
fd, worker_env = tempfile.mkstemp(suffix=".env")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")

# 5) La VM. Disco estándar de 20 GB y e2-small; IP externa efímera solo para salir a internet (DeepSeek, Supabase).
rc, out = gc("compute", "instances", "describe", VM, f"--zone={ZONE}", tolerate="was not found")
if rc == 0:
    print("la VM ya existe; se actualizan sus metadatos")
    gc("compute", "instances", "add-metadata", VM, f"--zone={ZONE}",
       f"--metadata-from-file=startup-script={os.path.join(HERE, 'worker_startup.sh')},worker-env={worker_env}")
else:
    gc("compute", "instances", "create", VM, f"--zone={ZONE}", "--machine-type=e2-small",
       "--image-family=debian-12", "--image-project=debian-cloud", "--boot-disk-size=20GB", "--boot-disk-type=pd-standard",
       f"--private-network-ip={IP}", f"--service-account={SA}", "--scopes=cloud-platform",
       f"--metadata-from-file=startup-script={os.path.join(HERE, 'worker_startup.sh')},worker-env={worker_env}")
    print("VM creada:", VM)
os.remove(worker_env)
