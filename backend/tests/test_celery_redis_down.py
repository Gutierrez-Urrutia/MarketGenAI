"""Con Redis caído el despacho a Celery debe fallar rápido, para que el fallback en línea de los
routers arranque en segundos. Antes tardaba ~110 s (20 reintentos del backend de resultados)."""
from __future__ import annotations

import time

import pytest
from celery import Celery

from app.workers.celery_app import RESULT_BACKEND_TRANSPORT_OPTIONS, celery_app


def test_el_backend_de_resultados_no_reintenta_20_veces():
    policy = RESULT_BACKEND_TRANSPORT_OPTIONS["retry_policy"]
    assert policy["max_retries"] <= 1  # el valor por defecto de Celery es 20
    assert policy["interval_max"] <= 1
    assert RESULT_BACKEND_TRANSPORT_OPTIONS["socket_connect_timeout"] <= 3
    assert celery_app.conf.result_backend_transport_options is RESULT_BACKEND_TRANSPORT_OPTIONS


def test_delay_con_redis_caido_falla_en_pocos_segundos():
    """Mismas opciones de transporte que la app real, apuntando a un puerto cerrado."""
    app = Celery(
        "redis_caido",
        broker="redis://127.0.0.1:9/0",
        backend="redis://127.0.0.1:9/1",
    )
    app.conf.update(
        task_publish_retry=False,
        task_publish_retry_policy={"max_retries": 1},
        broker_connection_timeout=5,
        broker_connection_max_retries=3,
        broker_transport_options=dict(celery_app.conf.broker_transport_options),
        result_backend_transport_options=RESULT_BACKEND_TRANSPORT_OPTIONS,
    )

    @app.task(name="tarea_de_prueba")
    def tarea_de_prueba():
        return 1

    started = time.monotonic()
    with pytest.raises(Exception):
        tarea_de_prueba.delay()
    elapsed = time.monotonic() - started
    assert elapsed < 30, f"el despacho tardó {elapsed:.0f}s con Redis caído"
