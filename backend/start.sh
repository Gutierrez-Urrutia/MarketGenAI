#!/usr/bin/env bash
set -e

echo "=================================================="
echo "🚀 Iniciando MarketGen AI Backend en Render"
echo "=================================================="

# Puerto dinámico asignado por Render (por defecto 10000 o 8000)
PORT="${PORT:-8000}"

# Manejador de señales para apagado limpio (Graceful Shutdown)
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

# 1. Iniciar el Worker de Celery en segundo plano (&)
echo "📦 Iniciando Celery Worker en segundo plano..."
celery -A app.workers.celery_app worker \
    --loglevel=info \
    -Q default,llm,exports \
    --concurrency=2 &
CELERY_PID=$!
echo "✅ Celery Worker iniciado con PID: $CELERY_PID"

# 2. Iniciar Uvicorn (FastAPI) en segundo plano y monitorear
echo "🌐 Iniciando FastAPI con Uvicorn en 0.0.0.0:$PORT..."
uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "$PORT" &
UVICORN_PID=$!
echo "✅ Uvicorn iniciado con PID: $UVICORN_PID"

# Esperar a que cualquiera de los dos procesos termine.
# Si Uvicorn o Celery falla o muere, wait -n devuelve el control y se ejecuta cleanup.
wait -n "$CELERY_PID" "$UVICORN_PID"
cleanup
