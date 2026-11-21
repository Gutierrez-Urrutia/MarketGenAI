"""RNF-05 (CP-177): las tareas Celery corren sus corrutinas siempre en el mismo ciclo de eventos, desde cualquier hilo.

Con el pool `solo` un reintento con cuenta regresiva corre en el hilo `Timer-1` y con el pool de hilos cada hilo es otro;
el cliente asíncrono de Firestore (singleton) queda atado al primer ciclo y fallaba con «attached to a different loop».
"""
import asyncio
import threading

import pytest

from app.workers.async_runner import run_async
from app.workers.tasks import asset_tasks, campaign_tasks, content_tasks, pipeline_tasks, proposal_tasks


async def _loop_id():
    return id(asyncio.get_running_loop())


def test_same_loop_for_every_call_from_the_same_thread():
    assert run_async(_loop_id()) == run_async(_loop_id())


def test_same_loop_when_called_from_different_threads():
    """El reintento (hilo Timer) debe usar el mismo ciclo que el primer intento (hilo principal)."""
    seen = {}

    def worker(name):
        seen[name] = run_async(_loop_id())

    main_loop = run_async(_loop_id())
    threads = [threading.Thread(target=worker, args=(f"hilo-{i}",), name=f"Timer-{i}") for i in range(3)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert set(seen.values()) == {main_loop}


def test_a_future_created_in_one_thread_can_be_awaited_from_another():
    """Reproduce el defecto: un recurso atado al ciclo (como el cliente gRPC de Firestore) se usa desde otro hilo."""
    holder = {}

    async def create():
        holder["fut"] = asyncio.get_running_loop().create_future()
        asyncio.get_running_loop().call_later(0.05, holder["fut"].set_result, "listo")

    async def use():
        return await holder["fut"]

    run_async(create())
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("r", run_async(use())), name="Timer-1")
    t.start(); t.join()
    assert out["r"] == "listo"


def test_exceptions_propagate_to_the_task():
    async def boom():
        raise ValueError("falla de la IA")

    with pytest.raises(ValueError, match="falla de la IA"):
        run_async(boom())


@pytest.mark.parametrize("module", [asset_tasks, campaign_tasks, content_tasks, pipeline_tasks, proposal_tasks])
def test_every_task_module_uses_the_shared_runner(module):
    assert module._run(_loop_id()) == run_async(_loop_id())
