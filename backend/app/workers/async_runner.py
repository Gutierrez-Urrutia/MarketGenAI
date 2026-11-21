"""Ejecuta corrutinas desde tareas Celery síncronas siempre en el MISMO ciclo de eventos.

Antes cada módulo de tareas tenía su propio `_run` que usaba el ciclo del hilo que ejecutaba la tarea. Pero el cliente
asíncrono de Firestore (gRPC) es un singleton atado al ciclo donde se usó por primera vez, y Celery no ejecuta todas las
tareas en el mismo hilo: con el pool `solo` (desarrollo en Windows) un reintento con cuenta regresiva corre en el hilo
`Timer-1`, y con el pool de hilos cada hilo es otro. En un ciclo distinto toda escritura a Firestore fallaba con
«RuntimeError: ... attached to a different loop», así que solo se alcanzaba 1 de los 3 reintentos (RNF-05, CP-177).

Aquí un único hilo de fondo mantiene un ciclo de eventos para todo el proceso, y cada tarea le entrega su corrutina y
espera el resultado. Funciona igual en cualquier pool (solo, hilos o procesos): con procesos, cada hijo crea el suyo
la primera vez que lo necesita.
"""
from __future__ import annotations

import asyncio
import os
import threading
from typing import Any, Coroutine, Optional

_lock = threading.Lock()
_loop: Optional[asyncio.AbstractEventLoop] = None
_thread: Optional[threading.Thread] = None
_owner_pid: Optional[int] = None


def _start() -> None:
    global _loop, _thread, _owner_pid
    loop = asyncio.new_event_loop()

    def _serve() -> None:
        asyncio.set_event_loop(loop)
        loop.run_forever()

    thread = threading.Thread(target=_serve, name="celery-async-loop", daemon=True)
    thread.start()
    _loop, _thread, _owner_pid = loop, thread, os.getpid()


def run_async(coro: Coroutine[Any, Any, Any]) -> Any:
    """Corre `coro` en el ciclo de eventos compartido del proceso y devuelve su resultado (o relanza su excepción)."""
    with _lock:
        # Si el proceso se bifurcó (prefork) el hilo del padre no existe en el hijo: se crea uno propio.
        if _loop is None or _loop.is_closed() or _owner_pid != os.getpid() or _thread is None or not _thread.is_alive():
            _start()
        loop = _loop
    return asyncio.run_coroutine_threadsafe(coro, loop).result()
