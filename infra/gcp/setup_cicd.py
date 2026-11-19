"""Configura (una vez, repetible) el despliegue automático desde GitHub Actions hacia marketgen-dev.

Crea la cuenta de servicio `marketgen-deployer` y un Workload Identity Pool: GitHub se identifica con un token
temporal y no hay claves JSON en el repositorio ni en los secretos de GitHub.

    python infra/gcp/setup_cicd.py

En Windows define GCLOUD con la ruta a gcloud.cmd (el script usa el Python incluido en el SDK para evitar que
cmd.exe rompa los argumentos con comillas).
"""
import os
import subprocess
import sys

PROJECT = "marketgen-dev"
PROJECT_NUMBER = "156520322318"
REPO = "Gutierrez-Urrutia/MarketGenAI"
POOL, PROVIDER = "github", "github-actions"
DEPLOYER = "marketgen-deployer"
DEPLOYER_EMAIL = f"{DEPLOYER}@{PROJECT}.iam.gserviceaccount.com"
# Ramas que pueden desplegar. Quitar la rama de pruebas cuando el workflow ya esté probado en main.
BRANCHES = sys.argv[1:] or ["main"]

_gcloud = os.environ.get("GCLOUD", "gcloud")
if _gcloud.lower().endswith("gcloud.cmd"):
    sdk = os.path.dirname(os.path.dirname(_gcloud))
    G = [os.path.join(sdk, "platform", "bundledpython", "python.exe"), os.path.join(sdk, "lib", "gcloud.py")]
else:
    G = [_gcloud]


def gc(*args, check=True):
    r = subprocess.run([*G, *args, f"--project={PROJECT}", "--quiet"], capture_output=True)
    out = (r.stdout + r.stderr).decode("utf-8", "replace").strip()
    if r.returncode != 0 and check:
        print("ERROR:", " ".join(args[:4]), "\n", out[-500:])
        sys.exit(1)
    return r.returncode, out


def exists(*args):
    return gc(*args, check=False)[0] == 0


# 1. Cuenta de servicio de despliegue
if not exists("iam", "service-accounts", "describe", DEPLOYER_EMAIL):
    gc("iam", "service-accounts", "create", DEPLOYER, "--display-name=MarketGen deployer (GitHub Actions)")
    print("cuenta creada:", DEPLOYER_EMAIL)

# 2. Permisos mínimos para construir, desplegar y reiniciar el worker
for role in ["roles/cloudbuild.builds.editor", "roles/logging.viewer", "roles/serviceusage.serviceUsageConsumer",
             "roles/run.admin", "roles/artifactregistry.writer", "roles/compute.instanceAdmin.v1",
             "roles/datastore.indexAdmin"]:   # crea los índices compuestos de Firestore (infra/gcp/apply_indexes.py)
    gc("projects", "add-iam-policy-binding", PROJECT, f"--member=serviceAccount:{DEPLOYER_EMAIL}", f"--role={role}",
       "--condition=None")
    print("rol:", role)

# `builds submit` sube el código al bucket de Cloud Build y antes consulta que exista (buckets.get).
for role in ["roles/storage.objectAdmin", "roles/storage.legacyBucketReader"]:
    gc("storage", "buckets", "add-iam-policy-binding", f"gs://{PROJECT}_cloudbuild",
       f"--member=serviceAccount:{DEPLOYER_EMAIL}", f"--role={role}")
# Debe poder «actuar como» las cuentas con las que corren Cloud Run, la VM y el build.
for sa in [f"marketgen-api@{PROJECT}.iam.gserviceaccount.com", f"marketgen-worker@{PROJECT}.iam.gserviceaccount.com",
           f"{PROJECT_NUMBER}-compute@developer.gserviceaccount.com"]:
    gc("iam", "service-accounts", "add-iam-policy-binding", sa, f"--member=serviceAccount:{DEPLOYER_EMAIL}",
       "--role=roles/iam.serviceAccountUser")
    print("actAs:", sa)

# `builds submit` lista los buckets del proyecto (GET /storage/v1/b?prefix=...) para ubicar el de Cloud Build; sin
# storage.buckets.list falla con un engañoso «forbidden ... serviceusage.services.use». Rol mínimo con solo ese permiso.
ROLE_ID = "bucketLister"
if not exists("iam", "roles", "describe", ROLE_ID):
    gc("iam", "roles", "create", ROLE_ID, "--title=Listar buckets (despliegue)", "--permissions=storage.buckets.list", "--stage=GA")
    print("rol personalizado creado:", ROLE_ID)
gc("projects", "add-iam-policy-binding", PROJECT, f"--member=serviceAccount:{DEPLOYER_EMAIL}",
   f"--role=projects/{PROJECT}/roles/{ROLE_ID}", "--condition=None")
print("rol:", ROLE_ID)

# 3. Workload Identity Federation: solo este repositorio y las ramas indicadas
condition = f"assertion.repository=='{REPO}' && (" + " || ".join(f"assertion.ref=='refs/heads/{b}'" for b in BRANCHES) + ")"
if not exists("iam", "workload-identity-pools", "describe", POOL, "--location=global"):
    gc("iam", "workload-identity-pools", "create", POOL, "--location=global", "--display-name=GitHub")
    print("pool creado")
provider_args = ["--location=global", f"--workload-identity-pool={POOL}", "--issuer-uri=https://token.actions.githubusercontent.com",
                 "--attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref",
                 f"--attribute-condition={condition}"]
verb = "update-oidc" if exists("iam", "workload-identity-pools", "providers", "describe", PROVIDER, "--location=global",
                               f"--workload-identity-pool={POOL}") else "create-oidc"
gc("iam", "workload-identity-pools", "providers", verb, PROVIDER, *provider_args)
print("proveedor:", verb, "| condición:", condition)

gc("iam", "service-accounts", "add-iam-policy-binding", DEPLOYER_EMAIL,
   f"--member=principalSet://iam.googleapis.com/projects/{PROJECT_NUMBER}/locations/global/workloadIdentityPools/{POOL}/attribute.repository/{REPO}",
   "--role=roles/iam.workloadIdentityUser")

print("\nlisto. En el workflow:")
print(f"  workload_identity_provider: projects/{PROJECT_NUMBER}/locations/global/workloadIdentityPools/{POOL}/providers/{PROVIDER}")
print(f"  service_account: {DEPLOYER_EMAIL}")
