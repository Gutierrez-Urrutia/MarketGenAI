#!/usr/bin/env bash
set -e

# ROLE define qué proceso corre este contenedor:
#   all    (por defecto) API + worker de Celery juntos. Es el comportamiento histórico y el que usa Render.
#   api    solo FastAPI/Uvicorn. Para Cloud Run: allí un proceso en segundo plano se queda sin CPU entre peticiones.
#   worker solo el worker de Celery. Para la VM que se enciende en las demostraciones.
ROLE="${ROLE:-all}"

echo "=================================================="
echo "🚀 Iniciando MarketGen AI Backend (rol: $ROLE)"
echo "=================================================="

case "$ROLE" in
    all|api|worker) ;;
    *)
        echo "❌ ROLE inválido: '$ROLE'. Usa all, api o worker." >&2
        exit 1
        ;;
esac

# Puerto dinámico asignado por la plataforma (Render o Cloud Run). Por defecto 8000.
PORT="${PORT:-8000}"
CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-2}"

start_worker() {
    echo "📦 Iniciando Celery Worker (concurrencia $CELERY_CONCURRENCY)..."
    celery -A app.workers.celery_app worker \
        --loglevel=info \
        -Q default,llm,exports \
        --concurrency="$CELERY_CONCURRENCY" "$@"
}

start_api() {
    echo "🌐 Iniciando FastAPI con Uvicorn en 0.0.0.0:$PORT..."
    uvicorn app.main:app \
        --host 0.0.0.0 \
        --port "$PORT" "$@"
}

# Un solo proceso: se reemplaza el shell con él (exec), así recibe SIGTERM directamente y apaga limpio.
if [ "$ROLE" = "worker" ]; then
    exec celery -A app.workers.celery_app worker \
        --loglevel=info \
        -Q default,llm,exports \
        --concurrency="$CELERY_CONCURRENCY"
fi

if [ "$ROLE" = "api" ]; then
    exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
fi

# ROLE=all: ambos procesos, con apagado limpio (igual que antes).
cleanup() {
    echo ""
    echo "⚠️ Señal de apagado recibida. Deteniendo procesos..."
    if [ -n "$CELERY_PID" ] && kill -0 "$CELERY_PID" 2>/dev/null; then
        echo "Deteniendo Celery worker (PID: $CELERY_PID)..."
        kill -TERM "$CELERY_PID" 2>/dev/null || true
        wait "$CELERY_PID" 2>/dev/null || true
    fi
    if [ -n "$UVICORN_PID" ] && kill -0 "$UVICORN_PID" 2>/dev/null; then
        echo "Deteniendo Uvicorn (PID: $UVICORN_PID)..."
        kill -TERM "$UVICORN_PID" 2>/dev/null || true
        wait "$UVICORN_PID" 2>/dev/null || true
    fi
    echo "✅ Procesos finalizados con éxito."
    exit 0
}

trap cleanup SIGTERM SIGINT

start_worker &
CELERY_PID=$!
echo "✅ Celery Worker iniciado con PID: $CELERY_PID"

start_api &
UVICORN_PID=$!
echo "✅ Uvicorn iniciado con PID: $UVICORN_PID"

# Si cualquiera de los dos procesos muere, se apaga el otro.
wait -n "$CELERY_PID" "$UVICORN_PID"
cleanup
