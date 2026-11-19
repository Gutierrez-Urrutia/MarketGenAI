"""RNF-04 · Arranque y manual de despliegue.

- Con APP_ENV=production, si falta una variable obligatoria el arranque se detiene y el mensaje las lista TODAS (CP-176).
- Fuera de producción no se detiene (solo avisa en el log).
- backend/.env.example, la clase Settings, render.yaml y docs/MANUAL-DESPLIEGUE.md no se contradicen.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from app.config import Settings, missing_required

RAIZ = Path(__file__).resolve().parents[2]
BACKEND = RAIZ / "backend"
FERNET = Fernet.generate_key().decode()

OBLIGATORIAS_OK = {
    "APP_ENV": "production", "APP_SECRET_KEY": "x" * 48, "GOOGLE_CLOUD_PROJECT": "proyecto-qa", "DEEPSEEK_API_KEY": "sk-qa",
    "PIPELINE_ENCRYPTION_KEY": FERNET, "STORAGE_BACKEND": "gcs", "GCS_BUCKET": "bucket-qa", "LOCAL_DEV_AUTH_ENABLED": "false",
}
NOMBRES = ["APP_SECRET_KEY", "GOOGLE_CLOUD_PROJECT", "DEEPSEEK_API_KEY", "PIPELINE_ENCRYPTION_KEY", "STORAGE_BACKEND", "GCS_BUCKET"]


def _arrancar(env_extra: dict, quitar: list[str] | None = None) -> subprocess.CompletedProcess:
    """Importa Settings en un proceso aparte con un entorno controlado (ni el .env local ni el del equipo influyen)."""
    env = {k: v for k, v in os.environ.items() if k not in NOMBRES and k not in ("APP_ENV", "FIREBASE_SERVICE_ACCOUNT_JSON")}
    env.update(env_extra)
    for k in quitar or []:
        env.pop(k, None)
    # cwd fuera de backend/: Settings lee ".env" del directorio actual y el del equipo (con valores reales) taparía lo que falta
    env["PYTHONPATH"] = str(BACKEND)
    code = "from app.config import Settings; Settings(_env_file=None); print('ARRANCO')"
    with tempfile.TemporaryDirectory() as vacio:
        return subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, cwd=vacio)


def test_RNF04_produccion_con_todo_arranca():
    out = _arrancar(OBLIGATORIAS_OK)
    assert "ARRANCO" in out.stdout, out.stderr[-600:]


@pytest.mark.parametrize("falta", ["APP_SECRET_KEY", "GOOGLE_CLOUD_PROJECT", "DEEPSEEK_API_KEY", "PIPELINE_ENCRYPTION_KEY", "GCS_BUCKET"])
def test_RNF04_produccion_sin_una_obligatoria_dice_cual_falta(falta):
    env = {k: v for k, v in OBLIGATORIAS_OK.items() if k != falta}
    out = _arrancar(env)
    assert "ARRANCO" not in out.stdout
    assert "Faltan variables de entorno obligatorias" in out.stderr and falta in out.stderr, out.stderr[-600:]
    # STORAGE_BACKEND aparece dentro del motivo de GCS_BUCKET («obligatoria con STORAGE_BACKEND=gcs»): no cuenta como otra variable que falte
    otras = [n for n in NOMBRES if n != falta and n in out.stderr and not (falta == "GCS_BUCKET" and n == "STORAGE_BACKEND")]
    assert not otras, f"el mensaje nombra variables que sí estaban: {otras}"


def test_RNF04_produccion_sin_ninguna_lista_todas_en_un_solo_mensaje():
    out = _arrancar({"APP_ENV": "production", "LOCAL_DEV_AUTH_ENABLED": "false"}, quitar=NOMBRES)
    assert "ARRANCO" not in out.stdout
    for n in ("APP_SECRET_KEY", "GOOGLE_CLOUD_PROJECT", "DEEPSEEK_API_KEY", "PIPELINE_ENCRYPTION_KEY", "STORAGE_BACKEND"):
        assert n in out.stderr, f"falta nombrar {n}"


def test_RNF04_llave_fernet_invalida_y_supabase_se_rechazan():
    problemas = missing_required(Settings(_env_file=None, app_secret_key="x" * 48, google_cloud_project="p", deepseek_api_key="k",
                                          pipeline_encryption_key="no-es-fernet", storage_backend="supabase"))
    texto = " | ".join(problemas)
    assert "PIPELINE_ENCRYPTION_KEY (no es una llave Fernet válida)" in texto and "STORAGE_BACKEND" in texto


def test_RNF04_fuera_de_produccion_no_se_detiene():
    out = _arrancar({"APP_ENV": "development", "LOCAL_DEV_AUTH_ENABLED": "true"}, quitar=NOMBRES)
    assert "ARRANCO" in out.stdout, out.stderr[-600:]


def test_RNF04_json_de_cuenta_de_servicio_invalido_se_informa():
    out = _arrancar({**OBLIGATORIAS_OK, "FIREBASE_SERVICE_ACCOUNT_JSON": "{no es json"})
    assert "ARRANCO" not in out.stdout and "FIREBASE_SERVICE_ACCOUNT_JSON" in out.stderr


# ── .env.example ⇔ Settings ⇔ manual ─────────────────────────────────────────

def _variables_del_ejemplo() -> set[str]:
    nombres = set()
    for linea in (BACKEND / ".env.example").read_text(encoding="utf-8").splitlines():
        m = re.match(r"^#?\s*([A-Z][A-Z0-9_]+)=", linea)
        if m:
            nombres.add(m.group(1))
    return nombres


# Variables de Settings sin uso (legado) o con valor propio del entorno: no hace falta documentarlas en el ejemplo.
LEGADO = ("KEYCLOAK_", "SUPABASE_", "GEMINI_")


def test_RNF04_toda_variable_de_settings_esta_en_el_ejemplo_salvo_el_legado():
    en_settings = {name.upper() for name in Settings.model_fields}
    faltan = sorted(v for v in en_settings - _variables_del_ejemplo() if not v.startswith(LEGADO))
    assert not faltan, f"variables de Settings que faltan en backend/.env.example: {faltan}"


def test_RNF04_el_ejemplo_no_trae_variables_que_ya_no_existen():
    en_settings = {name.upper() for name in Settings.model_fields} | {"ROLE", "CELERY_CONCURRENCY", "PORT"}
    sobran = sorted(v for v in _variables_del_ejemplo() if v not in en_settings)
    assert not sobran, f"variables de backend/.env.example que Settings ya no lee: {sobran}"


def test_RNF04_el_ejemplo_se_puede_cargar_sin_errores():
    """El ejemplo copiado a .env debe ser válido para pydantic (p. ej. sin cadenas vacías en campos numéricos)."""
    code = f"from app.config import Settings; Settings(_env_file={str(BACKEND / '.env.example')!r}); print('OK')"
    env = {**os.environ, "PYTHONPATH": str(BACKEND)}
    with tempfile.TemporaryDirectory() as vacio:
        out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, cwd=vacio)
    assert "OK" in out.stdout, out.stderr[-600:]


def test_RNF04_el_manual_nombra_cada_variable_obligatoria():
    manual = (RAIZ / "docs" / "MANUAL-DESPLIEGUE.md").read_text(encoding="utf-8")
    seccion = manual.split("### Backend — obligatorias", 1)[1].split("### Backend — según la funcionalidad", 1)[0]
    for nombre in NOMBRES:
        assert f"`{nombre}`" in seccion, f"el manual no lista como obligatoria {nombre}"
    assert "FIREBASE_SERVICE_ACCOUNT_JSON" in seccion
    assert "RNF-04" in manual and "RNF-05" not in manual


def test_RNF04_render_yaml_declara_las_obligatorias():
    render = (RAIZ / "render.yaml").read_text(encoding="utf-8")
    for nombre in NOMBRES:
        assert f"key: {nombre}" in render, nombre


def test_RNF04_existe_el_ejemplo_del_frontend():
    assert "VITE_API_URL" in (RAIZ / "frontend" / ".env.example").read_text(encoding="utf-8")
