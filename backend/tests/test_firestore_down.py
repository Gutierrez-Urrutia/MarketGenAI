"""RNF-04 · Si Firestore no responde, el usuario recibe un 503 claro (con CORS) y la aplicación sigue viva.

Antes no había manejador: cualquier router sin su propio try/except devolvía un 500 sin mensaje y sin cabeceras CORS (el navegador lo
veía como «Network Error»).
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from google.api_core import exceptions as gexc
from google.auth import exceptions as gauth
from httpx import ASGITransport, AsyncClient

API = "/api/v1"
ORIGEN = "http://localhost:5173"
SECRETO = "marketgen-dev-credenciales-C:\\secretos\\sa.json"


@pytest.fixture
async def http(app):
    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t") as c:
        yield c


@pytest.mark.parametrize("exc,codigo,texto", [
    (gexc.ServiceUnavailable(SECRETO), "db_unavailable", "base de datos no está disponible"),
    (gexc.DeadlineExceeded(SECRETO), "db_unavailable", "base de datos no está disponible"),
    (gexc.InternalServerError(SECRETO), "db_unavailable", "base de datos no está disponible"),
    (gexc.ResourceExhausted(SECRETO), "db_quota", "límite de uso"),
    (gauth.DefaultCredentialsError(SECRETO), "db_unavailable", "base de datos no está disponible"),   # credenciales de Firestore ausentes
    (gauth.RefreshError(SECRETO), "db_unavailable", "base de datos no está disponible"),
])
@pytest.mark.asyncio
async def test_RNF04_endpoint_de_datos_con_firestore_caido_responde_503_claro(http, exc, codigo, texto):
    with patch("app.routers.proposals.proposals_repo.list", new=AsyncMock(side_effect=exc)):
        r = await http.get(f"{API}/proposals", headers={"Origin": ORIGEN})
    assert r.status_code == 503, r.text
    body = r.json()
    assert body["code"] == codigo and texto in body["detail"]
    assert SECRETO not in r.text and "marketgen-dev" not in r.text and "sa.json" not in r.text
    # CORS: el navegador puede leer el mensaje en lugar de ver «Network Error»
    assert r.headers.get("access-control-allow-origin") == ORIGEN


@pytest.mark.asyncio
async def test_RNF04_con_firestore_caido_health_sigue_respondiendo(http):
    with patch("app.routers.proposals.proposals_repo.list", new=AsyncMock(side_effect=gexc.ServiceUnavailable("x"))):
        assert (await http.get(f"{API}/proposals")).status_code == 503
        assert (await http.get(f"{API}/health")).status_code == 200   # la aplicación sigue en pie


@pytest.mark.asyncio
async def test_RNF04_un_error_de_negocio_no_se_confunde_con_la_base_de_datos(http):
    from fastapi import HTTPException
    with patch("app.routers.proposals.proposals_repo.get_or_404", new=AsyncMock(side_effect=HTTPException(404, "Proposal 'x' not found."))):
        r = await http.get(f"{API}/proposals/x")
    assert r.status_code == 404
