"""RNF-01 · Control de acceso por rol (RBAC) — evidencia de los casos CP-064, 065, 066, 097, 098, 160, 161 y 162, y de HU-13.

Criterio (Historias de Usuario v2.0, RNF-VTA-01): todos los endpoints exigen autenticación (JWT); cada usuario accede solo
a sus propios datos; roles jerárquicos admin > manager > user; solo manager y admin editan precios y aprueban descuentos.
La parte de «descuentos» no tiene función que probar (ningún RF la define): queda como solicitud de cambio.
"""
from __future__ import annotations

import base64
import json
import re
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from fastapi import HTTPException
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient
from jose import jwt

from app.config import settings
from app.core.public_routes import PUBLIC_ROUTES
from app.dependencies.auth import CurrentUser, get_current_user, verify_token
from app.services import login_throttle_service
from app.services.auth_service import JWT_ALGORITHM, create_access_token, hash_password
from app.services.firestore_service import (
    books_repo,
    customers_repo,
    leads_repo,
    opportunities_repo,
    proposals_repo,
)

API = "/api/v1"
OTHER = "another-user-sub-999"


@pytest.fixture(autouse=True)
def _sin_escrituras_de_login_en_firestore():
    """Un inicio de sesión correcto actualiza `lastLoginAt` del usuario: en estas pruebas no hay Firestore real."""
    with patch("app.routers.auth.users_repo.touch_login", AsyncMock()):
        yield


# ── Clientes por rol ──────────────────────────────────────────────────────────
async def _client_as(app, role: str | None, sub: str | None = None):
    """Cliente con sesión de `role`; con role=None, sin sesión (la dependencia real de autenticación)."""
    previous = app.dependency_overrides.get(get_current_user)
    if role is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        user = CurrentUser(sub=sub or f"{role}-sub", email=f"{role}@example.com", name=role, roles=[role], raw={})
        app.dependency_overrides[get_current_user] = lambda: user
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as ac:
            yield ac
    finally:
        if previous is not None:
            app.dependency_overrides[get_current_user] = previous


@pytest_asyncio.fixture
async def anon(app):
    async for ac in _client_as(app, None):
        yield ac


@pytest_asyncio.fixture
async def as_user(app):
    async for ac in _client_as(app, "user", sub="user-sub"):
        yield ac


@pytest_asyncio.fixture
async def as_manager(app):
    async for ac in _client_as(app, "manager"):
        yield ac


@pytest_asyncio.fixture
async def as_admin(app):
    async for ac in _client_as(app, "admin"):
        yield ac


def _fill(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x", path)


def _routes():
    return [r for r in __import__("app.main", fromlist=["app"]).app.routes if isinstance(r, APIRoute)]


def _methods(route: APIRoute):
    return sorted(route.methods - {"HEAD", "OPTIONS"})


def _depends_on_auth(route: APIRoute) -> bool:
    found = set()

    def walk(dependant):
        for sub in dependant.dependencies:
            found.add(sub.call)
            walk(sub)

    walk(route.dependant)
    return verify_token in found


# ═════════════════════════════════════════════════════════════════════════════
# CP-064 · Todos los endpoints exigen autenticación
# ═════════════════════════════════════════════════════════════════════════════
class TestCP064TodosLosEndpointsExigenAutenticacion:
    def test_toda_ruta_sin_sesion_esta_en_la_lista_de_rutas_publicas(self, app):
        """Estático: una ruta nueva sin autenticación obliga a declararla (y justificarla) en core/public_routes.py."""
        sin_auth = {(m, r.path) for r in _routes() if not _depends_on_auth(r) for m in _methods(r)}
        no_declaradas = sorted(sin_auth - set(PUBLIC_ROUTES))
        assert not no_declaradas, f"Rutas sin autenticación que no están declaradas como públicas: {no_declaradas}"

    def test_la_lista_de_rutas_publicas_no_tiene_entradas_obsoletas(self, app):
        existentes = {(m, r.path) for r in _routes() for m in _methods(r)}
        assert not (set(PUBLIC_ROUTES) - existentes), "Hay rutas públicas declaradas que ya no existen"

    def test_ninguna_ruta_publica_declarada_exige_sesion_por_error(self, app):
        """Una ruta declarada pública pero protegida sería una lista engañosa."""
        protegidas = {(m, r.path) for r in _routes() if _depends_on_auth(r) for m in _methods(r)}
        assert not (set(PUBLIC_ROUTES) & protegidas)

    @pytest.mark.asyncio
    async def test_cada_ruta_protegida_responde_401_sin_token(self, app, anon):
        """Dinámico: se llama a cada ruta no pública sin credenciales."""
        fallas = []
        total = 0
        for route in _routes():
            for method in _methods(route):
                if (method, route.path) in PUBLIC_ROUTES:
                    continue
                total += 1
                resp = await anon.request(method, _fill(route.path), json={} if method in {"POST", "PUT", "PATCH"} else None)
                if resp.status_code != 401:
                    fallas.append((method, route.path, resp.status_code))
        assert total > 150          # el recorrido es real: hay más de 150 rutas protegidas
        assert not fallas, f"Rutas que no respondieron 401 sin token: {fallas}"

    @pytest.mark.asyncio
    async def test_la_respuesta_sin_sesion_pide_bearer(self, anon):
        resp = await anon.get(f"{API}/customers")
        assert resp.status_code == 401
        assert resp.headers["www-authenticate"] == "Bearer"


class TestRespaldoLocalDeArchivos:
    """GET /assets/local es público por diseño (enlaces simples): solo debe servir en desarrollo con respaldo en disco."""

    @pytest.mark.asyncio
    async def test_con_almacenamiento_en_la_nube_no_sirve_archivos(self, anon):
        with patch.object(settings, "storage_backend", "gcs"):
            assert (await anon.get(f"{API}/assets/local/assets/logo.png")).status_code == 404

    @pytest.mark.asyncio
    async def test_en_produccion_no_sirve_archivos(self, anon):
        with patch.object(settings, "app_env", "production"):
            assert (await anon.get(f"{API}/assets/local/assets/logo.png")).status_code == 404


# ═════════════════════════════════════════════════════════════════════════════
# CP-065 · Cada usuario accede solo a sus datos
# ═════════════════════════════════════════════════════════════════════════════
AJENO = {"id": "ajeno-1", "userId": OTHER, "title": "Dato de otro usuario", "name": "Otro", "company": "Otra SpA"}

DATOS_POR_USUARIO = [
    ("customers", customers_repo, "customers"),
    ("proposals", proposals_repo, "proposals"),
    ("leads", leads_repo, "leads"),
    ("opportunities", opportunities_repo, "opportunities"),
    ("books", books_repo, "books"),
]


class TestCP065CadaUsuarioAccedeSoloASusDatos:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("nombre,repo,ruta", DATOS_POR_USUARIO, ids=[d[0] for d in DATOS_POR_USUARIO])
    async def test_pedir_por_id_un_dato_de_otro_usuario_se_rechaza(self, client, nombre, repo, ruta):
        with patch.object(repo, "get", AsyncMock(return_value=AJENO)), patch.object(repo, "get_or_404", AsyncMock(return_value=AJENO)):
            resp = await client.get(f"{API}/{ruta}/ajeno-1")
        assert resp.status_code == 403, f"{nombre}: devolvió {resp.status_code}"
        assert "Dato de otro usuario" not in resp.text      # 0 accesos no autorizados: ni siquiera se filtra el contenido

    @pytest.mark.asyncio
    @pytest.mark.parametrize("nombre,repo,ruta", DATOS_POR_USUARIO, ids=[d[0] for d in DATOS_POR_USUARIO])
    async def test_un_id_inexistente_da_404_y_no_revela_nada(self, client, nombre, repo, ruta):
        with patch.object(repo, "get", AsyncMock(return_value=None)), patch.object(repo, "get_or_404", AsyncMock(side_effect=KeyError("x"))):
            resp = await client.get(f"{API}/{ruta}/no-existe")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_los_listados_se_piden_con_el_filtro_del_usuario(self, client):
        from tests.conftest import FAKE_USER_SUB
        with patch.object(proposals_repo, "list", AsyncMock(return_value=[])) as listar:
            await client.get(f"{API}/proposals")
        filtros = listar.await_args.kwargs.get("filters") or (listar.await_args.args[0] if listar.await_args.args else [])
        assert ("userId", "==", FAKE_USER_SUB) in filtros


# ═════════════════════════════════════════════════════════════════════════════
# CP-066 · Solo manager y admin editan precios (y aprueban descuentos)
# ═════════════════════════════════════════════════════════════════════════════
EDICION_DE_PRECIOS = [
    ("POST", f"{API}/catalog/services"),
    ("PATCH", f"{API}/catalog/services/x"),
    ("POST", f"{API}/catalog/service-types"),
    ("PATCH", f"{API}/catalog/service-types/x"),
]


class TestCP066SoloManagerYAdminEditanPrecios:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("metodo,ruta", EDICION_DE_PRECIOS)
    async def test_user_recibe_403(self, as_user, metodo, ruta):
        assert (await as_user.request(metodo, ruta, json={"price": 1})).status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.parametrize("metodo,ruta", EDICION_DE_PRECIOS)
    async def test_manager_y_admin_pasan_la_autorizacion(self, as_manager, as_admin, metodo, ruta):
        # Con un cuerpo vacío la validación responde 422: la autorización (que va antes) ya pasó. No es 401 ni 403.
        for cliente in (as_manager, as_admin):
            assert (await cliente.request(metodo, ruta, json={})).status_code not in (401, 403)

    @pytest.mark.asyncio
    async def test_aprobar_descuentos_no_tiene_funcion_que_probar(self, app):
        """Dejado explícito: ningún RF define descuentos (Plan de Pruebas, sección 11). Solicitud de cambio pendiente."""
        rutas = " ".join(r.path for r in _routes())
        assert "discount" not in rutas.lower() and "descuento" not in rutas.lower()


# ═════════════════════════════════════════════════════════════════════════════
# CP-097 · Token vencido o alterado
# ═════════════════════════════════════════════════════════════════════════════
def _token(**cambios) -> str:
    base = {"sub": "u-1", "email": "u@example.com", "roles": ["user"], "typ": "access", "iat": int(time.time()),
            "exp": int(time.time()) + 600}
    base.update(cambios)
    return jwt.encode(base, settings.app_secret_key, algorithm=JWT_ALGORITHM)


def _con_firma_alterada(token: str) -> str:
    cabecera, cuerpo, firma = token.split(".")
    return ".".join([cabecera, cuerpo, firma[:-4] + ("AAAA" if not firma.endswith("AAAA") else "BBBB")])


def _con_rol_alterado(token: str, roles) -> str:
    """Cambia el rol en el cuerpo SIN volver a firmar: la firma ya no corresponde."""
    cabecera, cuerpo, firma = token.split(".")
    datos = json.loads(base64.urlsafe_b64decode(cuerpo + "=" * (-len(cuerpo) % 4)))
    datos["roles"] = roles
    nuevo = base64.urlsafe_b64encode(json.dumps(datos).encode()).decode().rstrip("=")
    return ".".join([cabecera, nuevo, firma])


class TestCP097TokenVencidoOAlterado:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("token", [
        _token(exp=int(time.time()) - 60),                       # vencido
        _con_firma_alterada(_token()),                           # firma alterada
        jwt.encode({"sub": "u-1", "typ": "access", "exp": int(time.time()) + 600}, "otra-clave", algorithm=JWT_ALGORITHM),
        _token(typ="refresh"),                                   # no es un access token
        "no-es-un-jwt",
    ], ids=["vencido", "firma_alterada", "otra_clave", "typ_incorrecto", "basura"])
    async def test_responde_401_y_no_entrega_datos(self, anon, token):
        resp = await anon.get(f"{API}/customers", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 401
        assert "items" not in resp.text and resp.headers["www-authenticate"] == "Bearer"

    @pytest.mark.asyncio
    async def test_un_token_valido_si_se_acepta(self):
        from fastapi.security import HTTPAuthorizationCredentials
        user = await verify_token(HTTPAuthorizationCredentials(scheme="Bearer", credentials=_token()))
        assert user.sub == "u-1" and user.roles == ["user"]

    @pytest.mark.asyncio
    async def test_sin_cabecera_o_con_esquema_vacio_es_401(self, anon):
        assert (await anon.get(f"{API}/customers")).status_code == 401
        assert (await anon.get(f"{API}/customers", headers={"Authorization": "Bearer "})).status_code == 401
        assert (await anon.get(f"{API}/customers", headers={"Authorization": "Basic abc"})).status_code == 401


# ═════════════════════════════════════════════════════════════════════════════
# CP-098 · Intento de elevar privilegios
# ═════════════════════════════════════════════════════════════════════════════
class TestCP098ElevacionDePrivilegios:
    @pytest.mark.asyncio
    async def test_cambiar_el_rol_dentro_del_token_invalida_la_firma(self, anon):
        forjado = _con_rol_alterado(_token(roles=["user"]), ["admin"])
        resp = await anon.get(f"{API}/auth/debug-urls", headers={"Authorization": f"Bearer {forjado}"})
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_el_rol_real_user_sigue_recibiendo_403_en_una_ruta_de_admin(self, anon):
        resp = await anon.get(f"{API}/auth/debug-urls", headers={"Authorization": f"Bearer {_token(roles=['user'])}"})
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_pedir_el_rol_en_el_cuerpo_de_la_solicitud_no_cambia_nada(self, as_user):
        resp = await as_user.post(f"{API}/catalog/services", json={"name": "X", "price": 1, "roles": ["admin"], "role": "manager"})
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_put_me_ignora_roles(self, as_user):
        capturado = {}

        async def actualizar(user_id, data):
            capturado.update(data)
            return {"id": user_id, "email": "user@example.com", "name": data.get("name", "n"), "roles": ["user"], "status": "active"}

        with patch("app.routers.auth.users_repo.update", side_effect=actualizar):
            resp = await as_user.put(f"{API}/auth/me", json={"name": "Nuevo", "roles": ["admin"]})
        assert resp.status_code == 200
        assert capturado == {"name": "Nuevo"}                  # solo `name` llega a la base; `roles` se descarta

    @pytest.mark.asyncio
    async def test_el_registro_siempre_crea_rol_user(self, anon):
        creado = {}

        async def crear(data):
            creado.update(data)
            return {**data, "id": "nuevo-1"}

        with patch("app.routers.auth.users_repo.get_by_email", AsyncMock(return_value=None)), \
             patch("app.routers.auth.users_repo.create_user", side_effect=crear), \
             patch("app.routers.auth.refresh_tokens_repo.create_token", AsyncMock()):
            resp = await anon.post(f"{API}/auth/register", json={"email": "ana@example.com", "password": "12345678", "name": "Ana", "roles": ["admin"]})
        assert resp.status_code == 201
        assert creado["roles"] == ["user"]

    @pytest.mark.asyncio
    async def test_un_user_no_puede_cambiar_roles_ni_los_propios(self, as_user):
        resp = await as_user.patch(f"{API}/auth/users/user-sub/roles", json={"roles": ["admin"]})
        assert resp.status_code == 403


# ═════════════════════════════════════════════════════════════════════════════
# CP-160 · Matriz endpoint × rol (parametrizada)
# ═════════════════════════════════════════════════════════════════════════════
# Misma tabla que docs/rbac-permisos.md. Permitido = pasa la autorización (el resultado no es 401 ni 403).
MATRIZ = [
    # (método, ruta, cuerpo, anon, user, manager, admin)
    ("POST",   f"{API}/catalog/services",                {}, False, False, True,  True),
    ("PATCH",  f"{API}/catalog/services/x",              {}, False, False, True,  True),
    ("POST",   f"{API}/catalog/service-types",           {}, False, False, True,  True),
    ("PATCH",  f"{API}/catalog/service-types/x",         {}, False, False, True,  True),
    ("DELETE", f"{API}/knowledge/documents/x",           None, False, False, True,  True),
    ("PATCH",  f"{API}/auth/users/x/roles",              {}, False, False, False, True),
    ("GET",    f"{API}/admin/audit-logs",                None, False, False, False, True),
    ("GET",    f"{API}/auth/debug-urls",                 None, False, False, False, True),
    ("GET",    f"{API}/catalog/services",                None, False, True,  True,  True),     # lectura: cualquier usuario con sesión
    ("GET",    f"{API}/customers",                       None, False, True,  True,  True),
    ("POST",   f"{API}/knowledge/documents",             None, False, True,  True,  True),     # cualquier usuario carga documentos
]
ROLES = ["anon", "user", "manager", "admin"]


class TestCP160MatrizEndpointPorRol:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("rol", ROLES)
    @pytest.mark.parametrize("metodo,ruta,cuerpo,anon_ok,user_ok,manager_ok,admin_ok", MATRIZ, ids=[f"{m} {r.replace(API, '')}" for m, r, *_ in MATRIZ])
    async def test_cada_combinacion_coincide_con_la_tabla(self, app, rol, metodo, ruta, cuerpo, anon_ok, user_ok, manager_ok, admin_ok):
        esperado = {"anon": anon_ok, "user": user_ok, "manager": manager_ok, "admin": admin_ok}[rol]
        async for cliente in _client_as(app, None if rol == "anon" else rol):
            with patch("app.routers.admin.audit_logs_repo.search", AsyncMock(return_value=([], False))), \
                 patch("app.routers.knowledge.knowledge_documents_repo.get", AsyncMock(return_value=None)), \
                 patch("app.routers.knowledge.knowledge_documents_repo.list", AsyncMock(return_value=[])), \
                 patch("app.routers.catalog.service_catalog_repo.list", AsyncMock(return_value=[])), \
                 patch("app.routers.catalog.service_types_repo.list", AsyncMock(return_value=[])), \
                 patch("app.routers.customers.customers_repo.list", AsyncMock(return_value=[])), \
                 patch("app.routers.customers.customers_repo.count", AsyncMock(return_value=0)):
                kwargs = {"json": cuerpo} if cuerpo is not None else {}
                resp = await cliente.request(metodo, ruta, **kwargs)
        if rol == "anon":
            assert resp.status_code == 401
        elif esperado:
            assert resp.status_code not in (401, 403), f"{rol} debería pasar y devolvió {resp.status_code}"
        else:
            assert resp.status_code == 403, f"{rol} debería recibir 403 y devolvió {resp.status_code}"


# ═════════════════════════════════════════════════════════════════════════════
# CP-161 · Cierre de sesión y renovación del token
# ═════════════════════════════════════════════════════════════════════════════
class _RefreshStore:
    """Repositorio de refresh tokens en memoria (mismo contrato que RefreshTokensRepo)."""

    def __init__(self):
        self.docs = {}

    async def create_token(self, token_hash, data):
        self.docs[token_hash] = {**data, "id": token_hash}
        return self.docs[token_hash]

    async def get(self, token_hash):
        return self.docs.get(token_hash)

    async def revoke(self, token_hash):
        self.docs[token_hash]["revokedAt"] = datetime.now(timezone.utc)


USUARIO = {"id": "u-161", "email": "u161@example.com", "name": "U", "roles": ["user"], "status": "active"}


@pytest_asyncio.fixture
async def sesion(app):
    """Inicia sesión de verdad (contraseña verificada) contra repositorios en memoria."""
    store = _RefreshStore()
    usuario = {**USUARIO, "passwordHash": hash_password("clave-segura-1")}
    with patch("app.routers.auth.refresh_tokens_repo", store), \
         patch("app.routers.auth.users_repo.get_by_email", AsyncMock(return_value=usuario)), \
         patch("app.routers.auth.users_repo.get", AsyncMock(return_value=usuario)), \
         patch.object(login_throttle_service, "login_attempts_repo", _AttemptsStore()):
        async for cliente in _client_as(app, None):
            resp = await cliente.post(f"{API}/auth/login", json={"usernameOrEmail": USUARIO["email"], "password": "clave-segura-1"})
            assert resp.status_code == 200
            yield cliente, resp.json(), store


class TestCP161CierreDeSesionYRenovacion:
    @pytest.mark.asyncio
    async def test_renovar_con_un_token_valido_funciona_y_lo_rota(self, sesion):
        cliente, tokens, _ = sesion
        resp = await cliente.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
        assert resp.status_code == 200
        nuevos = resp.json()
        assert nuevos["accessToken"] and nuevos["refreshToken"] != tokens["refreshToken"]
        # El refresh token anterior ya no sirve (rotación).
        assert (await cliente.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})).status_code == 401

    @pytest.mark.asyncio
    async def test_tras_cerrar_sesion_el_refresh_token_deja_de_funcionar(self, app, sesion):
        cliente, tokens, _ = sesion
        sub = USUARIO["id"]
        user = CurrentUser(sub=sub, email=USUARIO["email"], roles=["user"], raw={})
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            assert (await cliente.post(f"{API}/auth/logout", json={"refreshToken": tokens["refreshToken"]})).status_code == 204
        finally:
            app.dependency_overrides.pop(get_current_user, None)
        resp = await cliente.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
        assert resp.status_code == 401 and resp.json()["detail"]["code"] == "TOKEN_EXPIRED_OR_REVOKED"

    @pytest.mark.asyncio
    async def test_cerrar_sesion_exige_estar_autenticado(self, anon):
        assert (await anon.post(f"{API}/auth/logout", json={"refreshToken": "x"})).status_code == 401

    @pytest.mark.asyncio
    async def test_un_refresh_token_inventado_o_vencido_es_401(self, sesion):
        cliente, _, store = sesion
        assert (await cliente.post(f"{API}/auth/refresh", json={"refreshToken": "inventado"})).status_code == 401
        for doc in store.docs.values():
            doc["expiresAt"] = datetime.now(timezone.utc) - timedelta(days=1)

    def test_el_access_token_vence_solo_segun_la_configuracion(self):
        """Decisión documentada: cerrar sesión revoca el refresh token; el access token (JWT sin estado) vence solo, a los
        `access_token_expire_minutes` (30 por defecto; el .env de cada entorno puede cambiarlo)."""
        datos = jwt.decode(create_access_token(USUARIO), settings.app_secret_key, algorithms=[JWT_ALGORITHM])
        assert datos["exp"] - datos["iat"] == settings.access_token_expire_minutes * 60
        assert 0 < settings.access_token_expire_minutes <= 60


# ═════════════════════════════════════════════════════════════════════════════
# CP-162 · Bloqueo tras intentos de inicio de sesión fallidos
# ═════════════════════════════════════════════════════════════════════════════
class _AttemptsStore:
    def __init__(self):
        self.docs = {}

    async def get(self, key):
        return self.docs.get(key)

    async def create(self, data, doc_id=None):
        self.docs[doc_id] = {**data, "id": doc_id}
        return self.docs[doc_id]

    async def delete(self, key):
        self.docs.pop(key, None)


@pytest_asyncio.fixture
async def login_env(app):
    store = _AttemptsStore()
    usuario = {**USUARIO, "passwordHash": hash_password("clave-segura-1")}
    with patch.object(login_throttle_service, "login_attempts_repo", store), \
         patch("app.routers.auth.users_repo.get_by_email", AsyncMock(side_effect=lambda email: usuario if email == USUARIO["email"] else None)), \
         patch("app.routers.auth.refresh_tokens_repo.create_token", AsyncMock()), \
         patch.object(settings, "local_dev_auth_enabled", False):
        async for cliente in _client_as(app, None):
            yield cliente, store


def _login(cliente, email=USUARIO["email"], password="mala"):
    return cliente.post(f"{API}/auth/login", json={"usernameOrEmail": email, "password": password})


class TestCP162BloqueoPorIntentosFallidos:
    @pytest.mark.asyncio
    async def test_tras_el_limite_la_cuenta_se_bloquea_y_lo_informa(self, login_env):
        cliente, _ = login_env
        for _ in range(settings.login_max_attempts - 1):
            r = await _login(cliente)
            assert r.status_code == 401 and r.json()["detail"]["code"] == "INVALID_CREDENTIALS"
        r = await _login(cliente)                                 # el intento que alcanza el límite
        assert r.status_code == 429
        detalle = r.json()["detail"]
        assert detalle["code"] == "ACCOUNT_LOCKED" and "minuto" in detalle["message"]
        assert int(r.headers["retry-after"]) == detalle["retryAfterSeconds"] == settings.login_lock_minutes * 60

    @pytest.mark.asyncio
    async def test_bloqueada_ni_la_contrasena_correcta_entra(self, login_env):
        cliente, _ = login_env
        for _ in range(settings.login_max_attempts):
            await _login(cliente)
        assert (await _login(cliente, password="clave-segura-1")).status_code == 429

    @pytest.mark.asyncio
    async def test_pasado_el_tiempo_de_bloqueo_se_puede_entrar_de_nuevo(self, login_env):
        cliente, store = login_env
        for _ in range(settings.login_max_attempts):
            await _login(cliente)
        for doc in store.docs.values():
            doc["lockedUntil"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        assert (await _login(cliente, password="clave-segura-1")).status_code == 200

    @pytest.mark.asyncio
    async def test_un_inicio_de_sesion_correcto_reinicia_el_contador(self, login_env):
        cliente, store = login_env
        for _ in range(settings.login_max_attempts - 1):
            await _login(cliente)
        assert (await _login(cliente, password="clave-segura-1")).status_code == 200
        assert store.docs == {}
        for _ in range(settings.login_max_attempts - 1):        # vuelve a tener todos los intentos
            assert (await _login(cliente)).status_code == 401

    @pytest.mark.asyncio
    async def test_un_correo_que_no_existe_se_comporta_igual(self, login_env):
        """No revela qué cuentas existen: el mismo número de intentos, el mismo bloqueo."""
        cliente, _ = login_env
        codigos = [(await _login(cliente, email="no-existe@example.com")).status_code for _ in range(settings.login_max_attempts)]
        assert codigos == [401] * (settings.login_max_attempts - 1) + [429]

    @pytest.mark.asyncio
    async def test_el_bloqueo_es_por_cuenta_no_afecta_a_otra(self, login_env):
        cliente, _ = login_env
        for _ in range(settings.login_max_attempts):
            await _login(cliente)
        assert (await _login(cliente, email="otra@example.com")).status_code == 401

    @pytest.mark.asyncio
    async def test_los_intentos_viejos_fuera_de_la_ventana_no_cuentan(self, login_env):
        cliente, store = login_env
        for _ in range(settings.login_max_attempts - 1):
            await _login(cliente)
        for doc in store.docs.values():
            doc["firstFailedAt"] = datetime.now(timezone.utc) - timedelta(minutes=settings.login_attempt_window_minutes + 1)
        assert (await _login(cliente)).status_code == 401       # la ventana venció: vuelve a contar desde 1

    @pytest.mark.asyncio
    async def test_si_el_almacen_de_intentos_falla_el_login_sigue_funcionando(self, app):
        usuario = {**USUARIO, "passwordHash": hash_password("clave-segura-1")}
        roto = AsyncMock(side_effect=RuntimeError("firestore caído"))
        with patch.object(login_throttle_service.login_attempts_repo, "get", roto), \
             patch.object(login_throttle_service.login_attempts_repo, "create", roto), \
             patch.object(login_throttle_service.login_attempts_repo, "delete", roto), \
             patch("app.routers.auth.users_repo.get_by_email", AsyncMock(return_value=usuario)), \
             patch("app.routers.auth.refresh_tokens_repo.create_token", AsyncMock()), \
             patch.object(settings, "local_dev_auth_enabled", False):
            async for cliente in _client_as(app, None):
                assert (await _login(cliente, password="clave-segura-1")).status_code == 200


# ═════════════════════════════════════════════════════════════════════════════
# HU-13 · El administrador gestiona los roles
# ═════════════════════════════════════════════════════════════════════════════
class TestHU13GestionDeRoles:
    URL = f"{API}/auth/users/u-5/roles"

    @pytest.mark.asyncio
    async def test_admin_cambia_los_roles(self, as_admin):
        with patch("app.routers.auth.users_repo.get", AsyncMock(return_value={"id": "u-5"})), \
             patch("app.routers.auth.users_repo.update", AsyncMock()) as actualizar:
            resp = await as_admin.patch(self.URL, json={"roles": ["manager", "user", "manager"]})
        assert resp.status_code == 200 and resp.json()["roles"] == ["manager", "user"]     # sin repetidos
        actualizar.assert_awaited_once_with("u-5", {"roles": ["manager", "user"]})

    @pytest.mark.asyncio
    @pytest.mark.parametrize("rol", ["user", "manager"])
    async def test_solo_el_admin_puede_cambiar_roles(self, app, rol):
        async for cliente in _client_as(app, rol):
            with patch("app.routers.auth.users_repo.update", AsyncMock()) as actualizar:
                resp = await cliente.patch(self.URL, json={"roles": ["admin"]})
            assert resp.status_code == 403
            actualizar.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("cuerpo", [{}, {"roles": []}, {"roles": ["superadmin"]}, {"roles": "admin"}, {"roles": [1]}, {"roles": ["admin", "x"]}])
    async def test_un_cuerpo_invalido_se_rechaza(self, as_admin, cuerpo):
        with patch("app.routers.auth.users_repo.get", AsyncMock(return_value={"id": "u-5"})), \
             patch("app.routers.auth.users_repo.update", AsyncMock()) as actualizar:
            resp = await as_admin.patch(self.URL, json=cuerpo)
        assert resp.status_code == 400
        actualizar.assert_not_called()

    @pytest.mark.asyncio
    async def test_un_usuario_que_no_existe_da_404(self, as_admin):
        with patch("app.routers.auth.users_repo.get", AsyncMock(return_value=None)), \
             patch("app.routers.auth.users_repo.update", AsyncMock()) as actualizar:
            resp = await as_admin.patch(self.URL, json={"roles": ["user"]})
        assert resp.status_code == 404
        actualizar.assert_not_called()

    @pytest.mark.asyncio
    async def test_sin_sesion_es_401(self, anon):
        assert (await anon.patch(self.URL, json={"roles": ["user"]})).status_code == 401
