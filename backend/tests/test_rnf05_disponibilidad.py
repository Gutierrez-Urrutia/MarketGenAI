"""RNF-05 · Disponibilidad e integración.

Criterio 1: una falla de un servicio externo (IA o CRM) se informa al usuario sin detener la aplicación.
- IA: aquí. Con DeepSeek caído, lento o respondiendo basura, cada endpoint que genera con IA devuelve un error
  claro (502/504 con un mensaje en español) y la aplicación sigue respondiendo.
- CRM: ya cubierto en tests/test_proposals_crm.py (401 credenciales, 504 timeout, 502 proveedor/conexión).
"""
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from openai import APIConnectionError, APIStatusError, RateLimitError

from app.services.deepseek_service import LLMTimeoutError

API = "/api/v1"
_REQ = httpx.Request("POST", "https://api.deepseek.com/chat/completions")


def _status_error(cls, code):
    return cls("x", response=httpx.Response(code, request=_REQ), body=None)


METRICS = {f"metric_{i}_{k}": v for i in (1, 2, 3) for k, v in (("label", "L"), ("value", "1"), ("description", "d"))}
ENDPOINTS = [
    ("analysis/seo", {"content": "hola mundo"}),
    ("analysis/ai-detection", {"content": "hola mundo"}),
    ("analysis/plagiarism", {"content": "hola mundo"}),
    ("outreach/review-queue/generate-response", {"name": "N", "company": "C", "contact_message": "hola"}),
    ("content/generate/whitepaper", {"title": "t", "subtitle": "s", "topic": "t", "target_audience": "a",
                                    "key_sections": ["a", "b", "c"], "abstract": "x"}),
    ("content/generate/template", {"template_name": "t", "channel": "email", "category": "c", "tone": "t",
                                  "use_case": "u", "merge_variables": ["x"]}),
    ("content/generate/social-post", {"platform": "linkedin", "topic": "t", "tone": "t", "target_audience": "a",
                                     "cta_text": "c", "key_points": ["k"]}),
]
FAILURES = {
    "timeout": (LLMTimeoutError("t"), 504),
    "sin_conexion": (APIConnectionError(request=_REQ), 502),
    "limite_de_uso": (_status_error(RateLimitError, 429), 502),
    "error_del_proveedor": (_status_error(APIStatusError, 503), 502),
}


@pytest.fixture
async def http(app):
    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t") as c:
        yield c


@pytest.mark.parametrize("failure", FAILURES.keys())
@pytest.mark.parametrize("path,body", ENDPOINTS, ids=[e[0] for e in ENDPOINTS])
@pytest.mark.asyncio
async def test_ai_failure_is_reported_and_app_keeps_running(http, path, body, failure):
    exc, expected = FAILURES[failure]
    with patch("app.services.deepseek_service.generate_text", new=AsyncMock(side_effect=exc)):
        r = await http.post(f"{API}/{path}", json=body)
    assert r.status_code == expected, r.text
    detail = r.json()["detail"]
    assert isinstance(detail, str) and "IA" in detail          # mensaje legible para el usuario
    assert (await http.get(f"{API}/health")).status_code == 200  # la aplicación sigue en pie


@pytest.mark.asyncio
async def test_analysis_with_unparseable_ai_output_is_502(http):
    with patch("app.services.deepseek_service.generate_text", new=AsyncMock(return_value="esto no es JSON")):
        r = await http.post(f"{API}/analysis/seo", json={"content": "hola"})
    assert r.status_code == 502
    assert "no se pudo interpretar" in r.json()["detail"]


@pytest.mark.asyncio
async def test_ai_error_response_keeps_cors_headers(http):
    """Si el error no lleva cabeceras CORS el navegador lo muestra como «error de red» y no el mensaje."""
    with patch("app.services.deepseek_service.generate_text", new=AsyncMock(side_effect=LLMTimeoutError("t"))):
        r = await http.post(f"{API}/analysis/seo", json={"content": "x"}, headers={"Origin": "http://localhost:5173"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"
