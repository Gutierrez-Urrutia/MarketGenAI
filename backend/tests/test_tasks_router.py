"""Tests for the asynchronous Celery tasks router and pilot task."""
from unittest.mock import MagicMock, patch
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.workers.tasks.pilot_tasks import task_pilot_deepseek


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


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
        assert "Redis" in data["detail"]


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
