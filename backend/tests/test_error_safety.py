"""RNF-04 · Los errores de un servicio externo se informan con un texto fijo y claro, sin detalles internos.

El detalle real (cuerpo del proveedor, claves parciales, hosts, rutas) va solo al log: nunca a la respuesta, al job ni al registro del CRM.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest
from google.api_core import exceptions as gexc
from httpx import ASGITransport, AsyncClient
from openai import APIConnectionError, AuthenticationError

from app.core import errors
from app.services import crm_service
from app.services.crm_service import CrmAuthError, CrmProviderError, CrmTimeoutError
from app.services.deepseek_service import LLMTimeoutError
from tests.conftest import FAKE_USER_SUB

API = "/api/v1"
SECRETO = "sk-CLAVE-SECRETA-1234567890"
_REQ = httpx.Request("POST", "https://api.deepseek.com/chat/completions")


@pytest.fixture
async def http(app):
    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t") as c:
        yield c


# ── safe_error ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("exc,codigo", [
    (LLMTimeoutError("tardó 30 s"), "llm_timeout"),
    (APIConnectionError(request=_REQ), "llm_unavailable"),
    (AuthenticationError(f"Incorrect API key provided: {SECRETO}", response=httpx.Response(401, request=_REQ), body=None), "llm_unavailable"),
    (CrmAuthError("API key inválida o sin permisos"), "crm_auth"),
    (CrmTimeoutError("Timeout al conectar con HubSpot"), "crm_timeout"),
    (httpx.ConnectError("[Errno -2] Name or service not known"), "unreachable"),
    (gexc.ServiceUnavailable("503 marketgen-dev: credenciales en C:\\secretos\\sa.json"), "db_unavailable"),
    (gexc.DeadlineExceeded("deadline"), "db_unavailable"),
    (gexc.ResourceExhausted("Quota exceeded"), "db_quota"),
    (RuntimeError(f"fallo interno con {SECRETO} en /app/secret.py"), "internal_error"),
])
def test_RNF04_safe_error_devuelve_un_texto_fijo_sin_detalles(exc, codigo):
    code, message = errors.safe_error(exc)
    assert code == codigo
    assert SECRETO not in message and "C:\\" not in message and "/app/" not in message and "Traceback" not in message


def test_RNF04_safe_error_message_deja_el_detalle_en_el_log(caplog):
    with caplog.at_level("ERROR", logger="marketgen.errors"):
        message = errors.safe_error_message(RuntimeError(f"boom {SECRETO}"))
    assert message == errors.GENERIC and SECRETO not in message
    assert SECRETO in caplog.text   # el detalle sí queda en el log


def test_RNF04_un_error_de_negocio_4xx_conserva_su_mensaje():
    from fastapi import HTTPException
    assert errors.safe_error(HTTPException(422, "El libro no tiene capítulos."))[1] == "El libro no tiene capítulos."
    assert errors.safe_error(HTTPException(500, "detalle interno"))[1] == errors.GENERIC


# ── El cuerpo del proveedor del CRM no viaja en el error ─────────────────────

@pytest.mark.asyncio
async def test_RNF04_error_del_proveedor_hubspot_no_incluye_el_cuerpo(caplog):
    class Resp:
        status_code = 500
        text = f'{{"message":"internal {SECRETO} token=abc"}}'
        def json(self):
            return {"message": f"internal {SECRETO} token=abc"}

    class Cli:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, *a, **k): return Resp()
        async def patch(self, *a, **k): return Resp()
        async def request(self, *a, **k): return Resp()
        async def get(self, *a, **k): return Resp()

    client = crm_service.HubSpotClient("pat-xyz")
    with patch("httpx.AsyncClient", return_value=Cli()), caplog.at_level("WARNING", logger="marketgen.crm"):
        with pytest.raises(CrmProviderError) as ei:
            await client.upsert_contact(email="a@b.cl", name="A", company="B")
    assert str(ei.value) == "HubSpot respondió con error 500"
    assert SECRETO not in str(ei.value)
    assert SECRETO in caplog.text


# ── /health/db ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_RNF04_health_db_caida_responde_503_sin_la_excepcion(http):
    with patch("app.routers.health.check_firestore_connection", new=AsyncMock(side_effect=gexc.ServiceUnavailable(f"proyecto marketgen-dev {SECRETO}"))):
        r = await http.get(f"{API}/health/db")
    assert r.status_code == 503
    assert r.json()["status"] == "error" and "marketgen-dev" not in r.text and SECRETO not in r.text


@pytest.mark.asyncio
async def test_RNF04_health_responde_200_aunque_firestore_este_caido(http):
    with patch("app.routers.health.check_firestore_connection", new=AsyncMock(side_effect=gexc.ServiceUnavailable("x"))):
        assert (await http.get(f"{API}/health")).status_code == 200


@pytest.mark.asyncio
async def test_RNF04_health_db_ok(http):
    with patch("app.routers.health.check_firestore_connection", new=AsyncMock(return_value=True)):
        r = await http.get(f"{API}/health/db")
    assert r.status_code == 200 and r.json()["status"] == "ok"


# ── tasks sin texto interno ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_RNF04_error_de_cola_no_muestra_el_host_del_broker(http, app):
    # RNF-05: consultar una tarea exige rol admin (antes cualquier sesión podía leer la tarea de otro usuario)
    from app.dependencies.auth import CurrentUser, verify_token
    previous = app.dependency_overrides.get(verify_token)
    app.dependency_overrides[verify_token] = lambda: CurrentUser(sub="admin-1", email="a@x.com", roles=["admin"], raw={"sub": "admin-1"})
    try:
        with patch("app.routers.tasks.AsyncResult", side_effect=RuntimeError("Error 111 connecting to redis://:clave@10.0.0.5:6379/0")):
            r = await http.get(f"{API}/tasks/abc123")
    finally:  # el fixture `app` dura toda la sesión: no dejar el override para otras pruebas
        if previous is None:
            app.dependency_overrides.pop(verify_token, None)
        else:
            app.dependency_overrides[verify_token] = previous
    assert r.status_code == 500
    assert "10.0.0.5" not in r.text and "clave" not in r.text and "redis://" not in r.text


# ── Otras integraciones: almacenamiento (GCS), llave de cifrado y origen de vacantes ─────────────────────────────

def test_RNF04_un_fallo_de_gcs_al_subir_es_un_StorageError_sin_detalles(monkeypatch, caplog):
    from app.services import storage_service
    monkeypatch.setattr(storage_service.settings, "storage_backend", "gcs")
    monkeypatch.setattr(storage_service, "_gcs_upload_bytes", lambda *a, **k: (_ for _ in ()).throw(gexc.ServiceUnavailable(f"bucket secreto {SECRETO}")))
    with caplog.at_level("ERROR", logger="marketgen.storage"):
        with pytest.raises(storage_service.StorageError) as ei:
            storage_service._upload_bytes_sync(b"x", "a/b.pdf", "application/pdf")
    assert SECRETO not in str(ei.value)
    assert SECRETO in caplog.text   # el detalle sí queda en el log


def test_RNF04_un_fallo_de_gcs_al_firmar_o_borrar_es_un_StorageError(monkeypatch):
    from app.services import storage_service
    monkeypatch.setattr(storage_service.settings, "storage_backend", "gcs")
    monkeypatch.setattr(storage_service, "_gcs_signed_url", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("sin permisos")))
    monkeypatch.setattr(storage_service, "_gcs_delete", lambda *a, **k: (_ for _ in ()).throw(gexc.Forbidden("sin permisos")))
    with pytest.raises(storage_service.StorageError):
        storage_service._get_signed_url_sync("a/b.pdf")
    with pytest.raises(storage_service.StorageError):
        storage_service._delete_file_sync("a/b.pdf")


@pytest.mark.parametrize("exc,codigo", [
    ("storage", "storage_unavailable"), ("cifrado", "encryption_not_configured"),
])
def test_RNF04_safe_error_conoce_el_almacenamiento_y_la_llave_de_cifrado(exc, codigo):
    from app.services.encryption_service import EncryptionNotConfiguredError
    from app.services.storage_service import StorageError
    error = StorageError(f"bucket {SECRETO}") if exc == "storage" else EncryptionNotConfiguredError(f"PIPELINE_ENCRYPTION_KEY {SECRETO}")
    code, message = errors.safe_error(error)
    assert code == codigo and SECRETO not in message and "PIPELINE_ENCRYPTION_KEY" not in message.replace("(PIPELINE_ENCRYPTION_KEY)", "")


@pytest.mark.asyncio
async def test_RNF04_storage_y_cifrado_responden_503_claro_con_cors(app):
    from app.services.encryption_service import EncryptionNotConfiguredError
    from app.services.storage_service import StorageError

    async def _storage():
        raise StorageError(f"detalle interno {SECRETO}")

    async def _cifrado():
        raise EncryptionNotConfiguredError(f"PIPELINE_ENCRYPTION_KEY is not set. {SECRETO}")

    app.add_api_route("/api/v1/_qa04/storage", _storage, methods=["GET"])
    app.add_api_route("/api/v1/_qa04/cifrado", _cifrado, methods=["GET"])
    try:
        async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t") as c:
            s = await c.get("/api/v1/_qa04/storage", headers={"Origin": "http://localhost:5173"})
            e = await c.get("/api/v1/_qa04/cifrado", headers={"Origin": "http://localhost:5173"})
    finally:
        app.router.routes[:] = [r for r in app.router.routes if "_qa04" not in getattr(r, "path", "")]
    assert s.status_code == 503 and s.json()["code"] == "storage_unavailable" and "almacenamiento" in s.json()["detail"] and SECRETO not in s.text
    assert e.status_code == 503 and e.json()["code"] == "encryption_not_configured" and SECRETO not in e.text and "is not set" not in e.text
    assert s.headers.get("access-control-allow-origin") == "http://localhost:5173"


@pytest.mark.asyncio
async def test_RNF04_pipeline_con_llave_de_cifrado_ausente_no_muestra_el_texto_de_la_excepcion(client):
    from app.services.encryption_service import EncryptionNotConfiguredError
    with patch("app.routers.pipeline.encryption_service.encrypt", side_effect=EncryptionNotConfiguredError("PIPELINE_ENCRYPTION_KEY is not set. Generate one with ...")), \
         patch("app.routers.pipeline._get_or_create_doc", new=AsyncMock(return_value={})):
        r = await client.put(f"{API}/pipeline/config", json={"hunter_api_key": "abc"})
    assert r.status_code == 503
    assert "Generate one with" not in r.text and "is not set" not in r.text and "llave de cifrado" in r.text
