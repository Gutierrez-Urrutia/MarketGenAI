#!/usr/bin/env bash
# Script de arranque de la VM del worker (se ejecuta en CADA encendido; es idempotente).
# Levanta Redis y el worker de Celery en contenedores. Los secretos se leen de Secret Manager
# con la cuenta de servicio de la VM; nunca se guardan en el disco más allá de /run (memoria).
set -euo pipefail
exec > >(tee -a /var/log/marketgen-startup.log) 2>&1
echo "== $(date -Is) arranque del worker"

MD="http://metadata.google.internal/computeMetadata/v1"
H="Metadata-Flavor: Google"
PROJECT="$(curl -sf -H "$H" "$MD/project/project-id")"
REGISTRY="us-central1-docker.pkg.dev"
IMAGE="$REGISTRY/$PROJECT/marketgen/api:dev"

# Docker se instala una sola vez (en los encendidos siguientes ya está).
if ! command -v docker >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y docker.io
fi
systemctl enable --now docker

# Acceso a Artifact Registry con el token de la cuenta de servicio de la VM.
curl -sf -H "$H" "$MD/instance/service-accounts/default/token" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])" \
    | docker login -u oauth2accesstoken --password-stdin "https://$REGISTRY"

secret() { gcloud secrets versions access latest --secret="$1" --project="$PROJECT"; }

# Variables: las no secretas vienen en el metadato "worker-env"; los secretos, de Secret Manager.
install -d -m 700 /run/marketgen
ENVF=/run/marketgen/worker.env
umask 077
curl -sf -H "$H" "$MD/instance/attributes/worker-env" > "$ENVF"
{
    echo "ROLE=worker"
    echo "REDIS_URL=$(secret redis-url)"
    echo "CELERY_RESULT_BACKEND=$(secret celery-result-backend)"
    echo "APP_SECRET_KEY=$(secret app-secret-key)"
    echo "PIPELINE_ENCRYPTION_KEY=$(secret pipeline-encryption-key)"
    echo "DEEPSEEK_API_KEY=$(secret deepseek-api-key)"
    echo "GEMINI_API_KEY=$(secret gemini-api-key)"
    echo "GOOGLE_API_KEY=$(secret google-api-key)"
    echo "SUPABASE_SERVICE_KEY=$(secret supabase-service-key)"
    echo "GOOGLE_OAUTH_CLIENT_SECRET=$(secret google-oauth-client-secret)"
} >> "$ENVF"
REDIS_PASSWORD="$(secret redis-password)"

# Redis (solo accesible desde la red interna; exige contraseña).
docker rm -f redis worker >/dev/null 2>&1 || true
install -d /var/lib/marketgen-redis
docker run -d --name redis --restart unless-stopped -p 6379:6379 \
    -v /var/lib/marketgen-redis:/data redis:7-alpine \
    redis-server --requirepass "$REDIS_PASSWORD" --save "60 1"

# Worker de Celery con la imagen más reciente.
docker pull "$IMAGE"
docker run -d --name worker --restart unless-stopped --env-file "$ENVF" "$IMAGE"

echo "== $(date -Is) worker y redis iniciados"
docker ps --format '{{.Names}}: {{.Status}}'
