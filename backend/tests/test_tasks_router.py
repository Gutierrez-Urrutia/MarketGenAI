"""Tests for the asynchronous Celery tasks router and pilot task."""
from contextlib import asynccontextmanager
from unittest.mock import MagicMock, patch
import pytest
from httpx import ASGITransport, AsyncClient

from app.dependencies.auth import CurrentUser, verify_token
from app.main import app
from app.workers.tasks.pilot_tasks import task_pilot_deepseek


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _user(roles):
    return CurrentUser(sub="u1", email="u@x.com", roles=roles, raw={"sub": "u1"})


@asynccontextmanager
async def _as(roles):
    """Cliente con el usuario indicado (None = sin sesión); restaura el override de la sesión de pruebas."""
    previous = app.dependency_overrides.pop(verify_token, None)
    if roles is not None:
        app.dependency_overrides[verify_token] = lambda: _user(roles)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        app.dependency_overrides.pop(verify_token, None)
        if previous is not None:
            app.dependency_overrides[verify_token] = previous


@pytest.fixture
async def client():
    """Cliente autenticado como administrador."""
    async with _as(["admin"]) as c:
        yield c


@pytest.fixture
async def anon_client():
    """Cliente sin sesión (sin override de autenticación)."""
    async with _as(None) as c:
        yield c


@pytest.fixture
async def user_client():
    """Cliente con sesión de usuario normal (sin rol admin)."""
    async with _as(["user"]) as c:
        yield c


@pytest.mark.asyncio
async def test_pilot_requires_login(anon_client: AsyncClient):
    with patch("app.routers.tasks.task_pilot_deepseek.delay") as mock_delay:
        r = await anon_client.post("/api/v1/tasks/pilot", json={"prompt": "Hola"})
    assert r.status_code in (401, 403)
    mock_delay.assert_not_called()


@pytest.mark.asyncio
async def test_pilot_forbidden_for_non_admin(user_client: AsyncClient):
    with patch("app.routers.tasks.task_pilot_deepseek.delay") as mock_delay:
        r = await user_client.post("/api/v1/tasks/pilot", json={"prompt": "Hola"})
    assert r.status_code == 403
    mock_delay.assert_not_called()


@pytest.mark.asyncio
async def test_task_status_requires_login(anon_client: AsyncClient):
    r = await anon_client.get("/api/v1/tasks/abc")
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_debug_urls_requires_admin(anon_client: AsyncClient, user_client: AsyncClient):
    assert (await anon_client.get("/api/v1/auth/debug-urls")).status_code in (401, 403)
    assert (await user_client.get("/api/v1/auth/debug-urls")).status_code == 403


@pytest.mark.asyncio
async def test_debug_urls_admin_does_not_leak_headers(client: AsyncClient):
    r = await client.get("/api/v1/auth/debug-urls", headers={"X-Secret": "s3"})
    assert r.status_code == 200
    assert "headers" not in r.json()


def test_docs_disabled_in_production():
    """Se comprueba en un proceso aparte para no recargar la app compartida de los tests."""
    import os, subprocess, sys
    code = (
        "from unittest.mock import MagicMock, patch\n"
        "with patch('google.cloud.firestore.AsyncClient', MagicMock()):\n"
        "    from app.main import app\n"
        "print(app.docs_url, app.openapi_url, app.redoc_url)\n"
    )
    from cryptography.fernet import Fernet
    env = {**os.environ, "APP_ENV": "production", "APP_SECRET_KEY": "x" * 48, "APP_DEBUG": "false",
           "LOCAL_DEV_AUTH_ENABLED": "false",
           # RNF-04: en producción el arranque exige estas variables
           "GOOGLE_CLOUD_PROJECT": "p", "DEEPSEEK_API_KEY": "k", "PIPELINE_ENCRYPTION_KEY": Fernet.generate_key().decode(),
           "STORAGE_BACKEND": "gcs", "GCS_BUCKET": "b"}
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
    assert out.stdout.strip().splitlines()[-1] == "None None None", out.stderr[-500:]


@pytest.mark.asyncio
async def test_enqueue_pilot_task_success(client: AsyncClient):
    mock_task = MagicMock()
    mock_task.id = "mock-task-id-12345"

    with patch("app.routers.tasks.task_pilot_deepseek.delay", return_value=mock_task) as mock_delay:
        response = await client.post(
            "/api/v1/tasks/pilot",
            json={
                "prompt": "Escribe un eslogan para NoonDalton",
                "system_prompt": "You are a creative marketer.",
                "temperature": 0.5,
            },
        )
        assert response.status_code == 202
        data = response.json()
        assert data["task_id"] == "mock-task-id-12345"
        assert data["status"] == "PENDING"
        assert "successfully" in data["message"].lower()

        mock_delay.assert_called_once_with(
            prompt="Escribe un eslogan para NoonDalton",
            system_prompt="You are a creative marketer.",
            temperature=0.5,
        )


@pytest.mark.asyncio
async def test_enqueue_pilot_task_broker_error(client: AsyncClient):
    with patch("app.routers.tasks.task_pilot_deepseek.delay", side_effect=Exception("Redis connection refused")):
        response = await client.post(
            "/api/v1/tasks/pilot",
            json={"prompt": "Hola"},
        )
        assert response.status_code == 503
        data = response.json()
        # RNF-04: mensaje fijo; el texto de la excepción (host, clave) no llega al cliente
        assert "servicio de colas" in data["detail"] and "Redis connection refused" not in data["detail"]


@pytest.mark.asyncio
async def test_get_task_status_pending(client: AsyncClient):
    mock_async_result = MagicMock()
    mock_async_result.ready.return_value = False
    mock_async_result.status = "PENDING"
    mock_async_result.successful.return_value = False

    with patch("app.routers.tasks.AsyncResult", return_value=mock_async_result):
        response = await client.get("/api/v1/tasks/mock-task-id-12345")
        assert response.status_code == 200
        data = response.json()
        assert data["task_id"] == "mock-task-id-12345"
        assert data["status"] == "PENDING"
        assert data["ready"] is False
        assert data["successful"] is None
        assert data["result"] is None
        assert data["error"] is None


@pytest.mark.asyncio
async def test_get_task_status_success(client: AsyncClient):
    mock_async_result = MagicMock()
    mock_async_result.ready.return_value = True
    mock_async_result.successful.return_value = True
    mock_async_result.status = "SUCCESS"
    mock_async_result.result = {
        "prompt": "Escribe un eslogan",
        "result": "NoonDalton: Tu socio global en operaciones",
        "status": "completed",
    }

    with patch("app.routers.tasks.AsyncResult", return_value=mock_async_result):
        response = await client.get("/api/v1/tasks/mock-task-id-12345")
        assert response.status_code == 200
        data = response.json()
        assert data["task_id"] == "mock-task-id-12345"
        assert data["status"] == "SUCCESS"
        assert data["ready"] is True
        assert data["successful"] is True
        assert data["result"]["status"] == "completed"
        assert data["error"] is None


@pytest.mark.asyncio
async def test_get_task_status_failure(client: AsyncClient):
    mock_async_result = MagicMock()
    mock_async_result.ready.return_value = True
    mock_async_result.successful.return_value = False
    mock_async_result.status = "FAILURE"
    mock_async_result.result = Exception("DeepSeek API timeout after 60s")

    with patch("app.routers.tasks.AsyncResult", return_value=mock_async_result):
        response = await client.get("/api/v1/tasks/mock-task-id-12345")
        assert response.status_code == 200
        data = response.json()
        assert data["task_id"] == "mock-task-id-12345"
        assert data["status"] == "FAILURE"
        assert data["ready"] is True
        assert data["successful"] is False
        assert "timeout" in data["error"]


def test_task_pilot_deepseek_function_success():
    with patch("app.services.deepseek_service._generate_text_sync", return_value="Generación exitosa"):
        res = task_pilot_deepseek.apply(
            kwargs={
                "prompt": "Test prompt",
                "system_prompt": "Test system",
                "temperature": 0.7,
            }
        ).get()

        assert res["prompt"] == "Test prompt"
        assert res["result"] == "Generación exitosa"
        assert res["status"] == "completed"
