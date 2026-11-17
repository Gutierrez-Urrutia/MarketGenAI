"""Despliega la API en Cloud Run (marketgen-dev). Variables no secretas desde .env; secretos desde Secret Manager."""
import subprocess, sys, os

G = os.environ.get("GCLOUD", "gcloud")  # en Windows: ruta completa a gcloud.cmd
PROJECT, REGION, SERVICE = "marketgen-dev", "us-central1", "marketgen-api"
IMAGE = "us-central1-docker.pkg.dev/marketgen-dev/marketgen/api:dev"
SA = "marketgen-api@marketgen-dev.iam.gserviceaccount.com"
ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend", ".env")
CORS = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173,http://127.0.0.1:5173"
FRONT = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5173"

env = {}
for line in open(ENV, encoding="utf-8"):
    line = line.rstrip("\n")
    if line.strip() and not line.lstrip().startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")

copiar = ["APP_NAME", "ACCESS_TOKEN_EXPIRE_MINUTES", "REFRESH_TOKEN_EXPIRE_DAYS", "PASSWORD_RESET_TOKEN_EXPIRE_MINUTES",
          "LOCAL_DEV_AUTH_EMAIL", "LOCAL_DEV_AUTH_NAME", "GEMINI_DEFAULT_MODEL", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
          "SUPABASE_URL", "SUPABASE_STORAGE_BUCKET", "GOOGLE_OAUTH_CLIENT_ID"]
vars_ = {k: env[k] for k in copiar if env.get(k)}
vars_.update({
    "ROLE": "api",
    "APP_ENV": "production",
    "APP_DEBUG": "false",
    "LOCAL_DEV_AUTH_ENABLED": "true",   # cuenta de desarrollo; su contraseña es un secreto nuevo, no la de siempre
    "GOOGLE_CLOUD_PROJECT": "marketgen-dev",
    "BACKEND_CORS_ORIGINS": CORS,
    "FRONTEND_URL": FRONT,
    "STORAGE_BACKEND": "gcs",            # los archivos van a Google Cloud Storage (Supabase ya no existe)
    "GCS_BUCKET": "marketgen-dev-assets",
})
path = os.path.join(os.path.dirname(__file__), "env_api.yaml")
with open(path, "w", encoding="utf-8") as f:
    for k, v in vars_.items():
        f.write(f'{k}: "{v}"\n')

secretos = {
    "APP_SECRET_KEY": "app-secret-key", "LOCAL_DEV_AUTH_PASSWORD": "local-dev-auth-password",
    "PIPELINE_ENCRYPTION_KEY": "pipeline-encryption-key", "DEEPSEEK_API_KEY": "deepseek-api-key",
    "GEMINI_API_KEY": "gemini-api-key", "GOOGLE_API_KEY": "google-api-key",
    "SUPABASE_SERVICE_KEY": "supabase-service-key", "GOOGLE_OAUTH_CLIENT_SECRET": "google-oauth-client-secret",
    "REDIS_URL": "redis-url", "CELERY_RESULT_BACKEND": "celery-result-backend",
}
set_secrets = ",".join(f"{k}={v}:latest" for k, v in secretos.items())

cmd = [G, "run", "deploy", SERVICE, f"--image={IMAGE}", f"--region={REGION}", f"--project={PROJECT}",
       f"--service-account={SA}", "--allow-unauthenticated", "--min-instances=0", "--max-instances=3",
       "--memory=1Gi", "--cpu=1", "--timeout=300", "--port=8080",
       # Salida directa a la VPC: así la API llega a Redis (en la VM) por la red interna.
       "--network=default", "--subnet=default", "--vpc-egress=private-ranges-only",
       f"--env-vars-file={path}", f"--set-secrets={set_secrets}", "--quiet"]
r = subprocess.run(cmd, capture_output=True)
out = (r.stdout + r.stderr).decode("utf-8", "replace")
print("\n".join(out.strip().splitlines()[-12:]))
os.remove(path)  # no dejar el archivo de variables en disco
sys.exit(r.returncode)
