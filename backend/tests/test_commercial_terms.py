"""RNF-03: aviso cuando una propuesta se queda sin condiciones comerciales.

La parte pura (detección en el HTML) se prueba directamente; el router con el repo reemplazado por
dobles, como en test_proposal_versions.py. El guardado nunca se bloquea: solo se agrega `warnings`.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services.commercial_terms import (
    WARNING_COMMERCIAL_TERMS_MISSING,
    has_commercial_terms,
    loses_commercial_terms,
)
from tests.conftest import FAKE_USER_SUB

API = "/api/v1/proposals"
REPO = "app.routers.proposals.proposals_repo"

PRICING = '<table class="pricing-table"><thead><tr><th>Servicio</th></tr></thead><tbody><tr><td>Gestores</td></tr></tbody></table>'
CON_TERMINOS = (
    "<h1>Propuesta</h1><h2>Resumen Ejecutivo</h2><p>Hola</p>"
    f"<h2>Precios y Condiciones Comerciales</h2>{PRICING}<ul><li>Vigencia hasta el 30-11</li><li>Pago a 30 días</li></ul>"
    "<h2>Condiciones Generales</h2><ul><li>Confidencialidad</li></ul>"
)
SIN_TERMINOS = (
    "<h1>Propuesta</h1><h2>Resumen Ejecutivo</h2><p>Hola</p>"
    f"<h2>Precios y Condiciones Comerciales</h2>{PRICING}"
    "<h2>Condiciones Generales</h2><ul><li>Confidencialidad</li></ul>"
)


# ── Detección ────────────────────────────────────────────────────────────────

def test_RNF03_detecta_las_condiciones_en_el_html_del_modelo():
    assert has_commercial_terms(CON_TERMINOS) is True


@pytest.mark.parametrize("heading,body", [
    ("Pricing and Commercial Terms", "<ul><li>Monthly billing</li></ul>"),
    ("Preços e Condições Comerciais", "<p>Faturamento mensal</p>"),
    ("PRECIOS Y CONDICIONES COMERCIALES", "<p>Pago a 30 días</p>"),
])
def test_RNF03_detecta_las_condiciones_en_es_en_y_pt(heading, body):
    assert has_commercial_terms(f"<h2>{heading}</h2>{PRICING}{body}") is True


def test_RNF03_detecta_la_seccion_dentro_del_html_profesional_guardado():
    guardado = (
        '<article data-sections="generic"><div class="proposal-paper">'
        f'<section><h2>Precios y Condiciones Comerciales</h2>{PRICING}'
        '<div class="proposal-total-card"><span>Total</span><strong>$10</strong></div>'
        "<ul><li>Pago a 30 días</li></ul></section></div></article>"
    )
    assert has_commercial_terms(guardado) is True
    sin = guardado.replace("<ul><li>Pago a 30 días</li></ul>", "")
    assert has_commercial_terms(sin) is False


def test_RNF03_la_tabla_de_precios_y_el_total_no_cuentan_como_condiciones():
    assert has_commercial_terms(SIN_TERMINOS) is False
    vacia = f"<h2>Precios y Condiciones Comerciales</h2>{PRICING}<ul><li>  </li></ul><p> </p>"
    assert has_commercial_terms(vacia) is False


def test_RNF03_sin_seccion_de_precios_o_sin_html_no_se_opina():
    assert has_commercial_terms("<h2>Resumen</h2><p>x</p>") is None
    assert has_commercial_terms("") is None
    assert has_commercial_terms(None) is None


def test_RNF03_el_texto_se_lee_aunque_traiga_html_hostil():
    hostil = f"<h2>Precios y Condiciones Comerciales</h2>{PRICING}<ul><li><script>alert(1)</script>Pago</li></ul>"
    assert has_commercial_terms(hostil) is True


def test_RNF03_avisa_solo_si_tenia_condiciones_y_ya_no_las_tiene():
    assert loses_commercial_terms(CON_TERMINOS, SIN_TERMINOS) is True
    assert loses_commercial_terms(CON_TERMINOS, "<h2>Resumen Ejecutivo</h2><p>Hola</p>") is True   # quitar la sección también las pierde
    assert loses_commercial_terms(CON_TERMINOS, CON_TERMINOS) is False
    assert loses_commercial_terms(SIN_TERMINOS, SIN_TERMINOS) is False   # ya no las tenía
    assert loses_commercial_terms("<p>legacy</p>", SIN_TERMINOS) is False   # formato libre: no se opina
    assert loses_commercial_terms(None, SIN_TERMINOS) is False


# ── PUT /proposals/{id} ──────────────────────────────────────────────────────

def _proposal(content: str) -> dict:
    return {"id": "proposal-001", "userId": FAKE_USER_SUB, "title": "Propuesta", "proposal_status": "borrador", "content": content}


async def _put(client, antes: str, nuevo: dict):
    despues = {**_proposal(antes), **nuevo}
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=_proposal(antes)),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=despues),
        patch("app.routers.proposals._auto_snapshot", new_callable=AsyncMock),
        patch("app.routers.proposals._audit", new_callable=AsyncMock),
    ):
        return await client.put(f"{API}/proposal-001", json=nuevo)


@pytest.mark.asyncio
async def test_RNF03_guardar_sin_condiciones_guarda_y_advierte(client):
    resp = await _put(client, CON_TERMINOS, {"content": SIN_TERMINOS})
    assert resp.status_code == 200
    assert resp.json()["warnings"] == [WARNING_COMMERCIAL_TERMS_MISSING]
    assert resp.json()["content"] == SIN_TERMINOS   # el guardado no se bloquea


@pytest.mark.asyncio
async def test_RNF03_guardar_con_condiciones_no_advierte(client):
    editado = CON_TERMINOS.replace("Pago a 30 días", "Pago a 45 días")
    resp = await _put(client, CON_TERMINOS, {"content": editado})
    assert resp.status_code == 200
    assert "warnings" not in resp.json()


@pytest.mark.asyncio
async def test_RNF03_editar_otros_campos_no_advierte(client):
    resp = await _put(client, SIN_TERMINOS, {"title": "Otro título"})
    assert resp.status_code == 200
    assert "warnings" not in resp.json()


@pytest.mark.asyncio
async def test_RNF03_no_advierte_si_la_propuesta_ya_no_tenia_condiciones(client):
    resp = await _put(client, SIN_TERMINOS, {"content": SIN_TERMINOS + "<p>otra cosa</p>"})
    assert resp.status_code == 200
    assert "warnings" not in resp.json()
