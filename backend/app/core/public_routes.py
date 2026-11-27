"""Rutas que NO exigen sesión (RNF-01: «todos los endpoints exigen autenticación»).

Es la única excepción permitida y está documentada aquí con su motivo. La prueba `tests/test_rnf01_access_control.py`
recorre todas las rutas de la aplicación y falla si aparece una ruta sin sesión que no esté en esta lista, así que
agregar una ruta pública obliga a declararla (y justificarla) en este archivo.

La clave es (método, ruta tal como la declara FastAPI, con sus {parámetros}).
"""
from __future__ import annotations

PUBLIC_ROUTES: dict[tuple[str, str], str] = {
    # Salud y raíz: los monitores (Cloud Run, balanceador) no tienen sesión. /health/db no filtra el detalle del error (RNF-04).
    ("GET", "/"): "raíz del servicio",
    ("GET", "/api/v1/health"): "monitoreo",
    ("GET", "/api/v1/health/db"): "monitoreo de la base de datos, sin detalle interno",
    # Entrada a la cuenta: no pueden exigir una sesión que todavía no existe.
    ("POST", "/api/v1/auth/login"): "inicio de sesión (limitado por IP y por cuenta)",
    ("POST", "/api/v1/auth/register"): "registro; siempre crea rol user",
    ("POST", "/api/v1/auth/refresh"): "renovación con refresh token opaco, rotativo y revocable",
    ("POST", "/api/v1/auth/forgot-password"): "recuperación de contraseña; responde igual exista o no la cuenta",
    ("POST", "/api/v1/auth/reset-password"): "restablecimiento con token de un solo uso",
    # Retorno de proveedores OAuth: los llama el navegador desde Google, Microsoft o Meta; validan un `state` firmado.
    ("GET", "/api/v1/auth/google"): "inicio del flujo OAuth de Google",
    ("GET", "/api/v1/auth/google/callback"): "retorno de Google (state firmado)",
    ("GET", "/api/v1/auth/microsoft"): "inicio del flujo OAuth de Microsoft",
    ("GET", "/api/v1/auth/microsoft/callback"): "retorno de Microsoft (state firmado)",
    ("POST", "/api/v1/mail-connection/callback"): "retorno de Microsoft para el buzón (state firmado)",
    ("GET", "/api/v1/mail-connection/google/callback"): "retorno de Google para el buzón (state firmado)",
    ("GET", "/api/v1/settings/social/facebook/callback"): "retorno de Meta (state firmado)",
    # Se abre como un enlace simple, sin cabecera: lleva un token temporal firmado y vinculado a la propuesta y al archivo.
    ("GET", "/api/v1/proposals/{proposal_id}/signed-document/file"): "enlace temporal firmado de documento firmado",
    # Respaldo en disco del almacenamiento. Solo responde en desarrollo con almacenamiento local (ver assets.get_local_asset).
    ("GET", "/api/v1/assets/local/{file_path:path}"): "respaldo local de archivos; deshabilitado con almacenamiento en la nube y en producción",
}
