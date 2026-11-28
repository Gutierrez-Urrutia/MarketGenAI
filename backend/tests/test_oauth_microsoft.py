"""Login con Microsoft (Entra ID, inquilino único): URI de retorno, state + PKCE en cookie firmada, comprobación del
directorio y reglas de cuenta. Microsoft va simulado con httpx.MockTransport: no sale a la red ni toca Firestore."""
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
import jwt
from starlette.requests import Request

from app.routers import oauth

TENANT = "11111111-2222-3333-4444-555555555555"
CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
SECRET_KEY = "clave-de-pruebas-del-servidor"
REAL_ASYNC_CLIENT = httpx.AsyncClient


def _request(cookie: str | None = None, host: str = "api.example.com") -> Request:
    headers = [(b"host", host.encode()), (b"x-forwarded-proto", b"https"), (b"x-forwarded-host", host.encode())]
    if cookie is not None:
        headers.append((b"cookie", f"{oauth._MS_COOKIE}={cookie}".encode()))
    return Request({"type": "http", "method": "GET", "scheme": "https", "path": "/api/v1/auth/microsoft", "headers": headers})


def _query(response) -> dict:
    return parse_qs(urlparse(response.headers["location"]).query)


def _set_cookies(response) -> list[str]:
    return [v.decode() for k, v in response.raw_headers if k == b"set-cookie"]


def _id_token(tid: str = TENANT, aud: str = CLIENT_ID) -> str:
    return jwt.encode({"tid": tid, "aud": aud, "oid": "oid-1"}, "no-importa", algorithm="HS256")


def _cookie(state: str = "state-1", verifier: str = "verificador-1", **extra) -> str:
    payload = {"typ": oauth._MS_COOKIE_TYPE, "st": state, "cv": verifier,
               "exp": datetime.now(timezone.utc) + timedelta(minutes=5), **extra}
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


class FakeMicrosoft:
    """Servidor de Microsoft simulado: guarda lo que recibió y responde con lo configurado."""

    def __init__(self, monkeypatch, *, token_status=200, id_token=None, me_status=200, me=None, boom=None):
        self.token_requests: list[tuple[str, dict]] = []
        self.me_calls = 0
        self.token_status = token_status
        self.id_token = _id_token() if id_token is None else id_token
        self.me_status = me_status
        self.me = me if me is not None else {"id": "oid-1", "mail": "Ana@Empresa.com", "displayName": "Ana"}
        self.boom = boom

        def handler(request: httpx.Request) -> httpx.Response:
            if self.boom:
                raise self.boom
            if request.url.host == "login.microsoftonline.com":
                self.token_requests.append((str(request.url), {k: v[0] for k, v in parse_qs(request.content.decode()).items()}))
                if self.token_status != 200:
                    return httpx.Response(self.token_status, json={"error": "invalid_grant"})
                return httpx.Response(200, json={"access_token": "ms-token", "id_token": self.id_token})
            self.me_calls += 1
            return httpx.Response(self.me_status, json=self.me)

        monkeypatch.setattr(oauth.httpx, "AsyncClient",
                            lambda **kw: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kw))


@pytest.fixture(autouse=True)
def entorno(monkeypatch):
    s = oauth.settings
    monkeypatch.setattr(s, "app_secret_key", SECRET_KEY)
    monkeypatch.setattr(s, "microsoft_oauth_client_id", CLIENT_ID)
    monkeypatch.setattr(s, "microsoft_oauth_client_secret", "secreto-de-cliente")
    monkeypatch.setattr(s, "microsoft_tenant_id", TENANT)
    monkeypatch.setattr(s, "microsoft_redirect_uri", "")
    monkeypatch.setattr(s, "frontend_url", "https://web.example.com")
    monkeypatch.setattr(oauth, "create_access_token", lambda user: "access-token")
    monkeypatch.setattr(oauth, "new_opaque_token", lambda: "refresh-token")
    monkeypatch.setattr(oauth, "hash_token", lambda token: "hashed")
    monkeypatch.setattr(oauth, "refresh_expires_at", lambda: "expires")
    monkeypatch.setattr(oauth, "public_user", lambda user: {"id": user["id"]})
    monkeypatch.setattr(oauth.refresh_tokens_repo, "create_token", AsyncMock())
    monkeypatch.setattr(oauth.users_repo, "touch_login", AsyncMock())
    monkeypatch.setattr(oauth.users_repo, "update", AsyncMock())
    monkeypatch.setattr(oauth.users_repo, "get_by_email", AsyncMock(return_value=None))
    monkeypatch.setattr(oauth.users_repo, "create_user",
                        AsyncMock(side_effect=lambda data: {"id": "user-nuevo", **data}))


# ── URI de retorno ───────────────────────────────────────────────────────────

def test_callback_url_uses_the_configured_redirect_uri(monkeypatch):
    monkeypatch.setattr(oauth.settings, "microsoft_redirect_uri", "https://fija.example.com/api/v1/auth/microsoft/callback")
    assert oauth._microsoft_callback_url(_request()) == "https://fija.example.com/api/v1/auth/microsoft/callback"


def test_callback_url_falls_back_to_the_request_host_not_localhost():
    # Antes salía siempre http://localhost:8000 (leía un ajuste que no existe): en Cloud Run Microsoft lo rechazaba.
    assert oauth._microsoft_callback_url(_request(host="mi-api.run.app")) == (
        "https://mi-api.run.app/api/v1/auth/microsoft/callback")


# ── inicio del login ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_login_start_goes_to_the_tenant_with_pkce_and_state():
    response = await oauth.microsoft_auth(_request())
    url = urlparse(response.headers["location"])
    q = _query(response)

    assert url.netloc == "login.microsoftonline.com"
    assert url.path == f"/{TENANT}/oauth2/v2.0/authorize"          # nunca /common/
    assert q["client_id"] == [CLIENT_ID]
    assert q["code_challenge_method"] == ["S256"] and q["code_challenge"][0]
    assert len(q["state"][0]) >= 32
    assert q["redirect_uri"] == ["https://api.example.com/api/v1/auth/microsoft/callback"]


@pytest.mark.asyncio
async def test_login_start_sets_a_signed_short_lived_cookie_with_the_state_and_verifier():
    response = await oauth.microsoft_auth(_request())
    (cookie,) = _set_cookies(response)
    value = cookie.split(";")[0].split("=", 1)[1]
    data = jwt.decode(value, SECRET_KEY, algorithms=["HS256"])

    assert data["st"] == _query(response)["state"][0]
    assert oauth.code_challenge(data["cv"]) == _query(response)["code_challenge"][0]
    assert data["typ"] == "ms_oauth"                                 # no sirve como token de sesión
    low = cookie.lower()
    assert "httponly" in low and "samesite=lax" in low and "secure" in low
    assert f"path={oauth._MS_COOKIE_PATH}".lower() in low and "max-age=600" in low


@pytest.mark.asyncio
async def test_cookie_is_not_secure_on_plain_http_local(monkeypatch):
    monkeypatch.setattr(oauth.settings, "microsoft_redirect_uri", "http://localhost:8000/api/v1/auth/microsoft/callback")
    (cookie,) = _set_cookies(await oauth.microsoft_auth(_request()))
    assert "secure" not in cookie.lower()


@pytest.mark.asyncio
@pytest.mark.parametrize("campo", ["microsoft_oauth_client_id", "microsoft_oauth_client_secret", "microsoft_tenant_id"])
async def test_login_start_is_501_when_the_integration_is_incomplete(monkeypatch, campo):
    monkeypatch.setattr(oauth.settings, campo, "")
    with pytest.raises(oauth.HTTPException) as ei:
        await oauth.microsoft_auth(_request())
    assert ei.value.status_code == 501


# ── retorno: state y PKCE ────────────────────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("cookie,state", [
    (None, "state-1"),                                               # sin cookie
    ("esto-no-es-un-jwt", "state-1"),                                # manipulada
    (_cookie(), "otro-state"),                                       # state distinto: CSRF
    (_cookie(), None),                                               # sin state
    (_cookie(exp=datetime.now(timezone.utc) - timedelta(seconds=1)), "state-1"),   # vencida
    (jwt.encode({"typ": "access", "st": "state-1", "cv": "v", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
                SECRET_KEY, algorithm="HS256"), "state-1"),          # otro tipo de token
    (jwt.encode({"typ": "ms_oauth", "st": "state-1", "cv": "v"}, "otra-clave", algorithm="HS256"), "state-1"),  # otra firma
])
async def test_callback_refuses_a_state_that_does_not_match(monkeypatch, cookie, state):
    ms = FakeMicrosoft(monkeypatch)
    response = await oauth.microsoft_callback(_request(cookie), code="codigo", state=state)

    assert _query(response)["oauth_error"] == ["microsoft_state_invalid"]
    assert ms.token_requests == []                                   # ni siquiera se canjea el código
    oauth.refresh_tokens_repo.create_token.assert_not_called()
    assert any("max-age=0" in c.lower() for c in _set_cookies(response))   # la cookie se borra


@pytest.mark.asyncio
async def test_callback_denied_or_without_code_redirects_with_microsoft_denied(monkeypatch):
    FakeMicrosoft(monkeypatch)
    for kwargs in ({"error": "access_denied"}, {}):
        response = await oauth.microsoft_callback(_request(_cookie()), state="state-1", **kwargs)
        assert _query(response)["oauth_error"] == ["microsoft_denied"]


# ── retorno: canje del código y sesión ───────────────────────────────────────

@pytest.mark.asyncio
async def test_successful_login_creates_the_user_and_sends_the_pkce_verifier(monkeypatch):
    ms = FakeMicrosoft(monkeypatch)
    response = await oauth.microsoft_callback(_request(_cookie()), code="codigo-1", state="state-1")

    (url, form), = ms.token_requests
    assert urlparse(url).path == f"/{TENANT}/oauth2/v2.0/token"
    assert form["code"] == "codigo-1" and form["code_verifier"] == "verificador-1"
    assert form["client_id"] == CLIENT_ID and form["client_secret"] == "secreto-de-cliente"
    assert form["redirect_uri"] == "https://api.example.com/api/v1/auth/microsoft/callback"

    created = oauth.users_repo.create_user.await_args.args[0]
    assert created["email"] == "ana@empresa.com" and created["roles"] == ["user"]
    assert created["microsoftId"] == "oid-1" and created["status"] == "active"

    location = urlparse(response.headers["location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == "https://web.example.com/auth/callback"
    assert _query(response)["oauth_access_token"] == ["access-token"]
    assert any("max-age=0" in c.lower() for c in _set_cookies(response))   # la cookie ya no se necesita


@pytest.mark.asyncio
async def test_falls_back_to_user_principal_name_when_there_is_no_mail(monkeypatch):
    FakeMicrosoft(monkeypatch, me={"id": "oid-1", "mail": None, "userPrincipalName": "luis@empresa.com", "displayName": "Luis"})
    await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")
    assert oauth.users_repo.create_user.await_args.args[0]["email"] == "luis@empresa.com"


@pytest.mark.asyncio
@pytest.mark.parametrize("id_token", [_id_token(tid="99999999-0000-0000-0000-000000000000"), _id_token(aud="otra-app")])
async def test_a_token_from_another_directory_or_app_is_refused(monkeypatch, id_token):
    ms = FakeMicrosoft(monkeypatch, id_token=id_token)
    response = await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")

    assert _query(response)["oauth_error"] == ["microsoft_wrong_tenant"]
    assert ms.me_calls == 0
    oauth.users_repo.create_user.assert_not_called()
    oauth.refresh_tokens_repo.create_token.assert_not_called()


@pytest.mark.asyncio
async def test_a_response_without_a_readable_id_token_is_refused(monkeypatch):
    FakeMicrosoft(monkeypatch, id_token="no-es-un-jwt")
    response = await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")
    assert _query(response)["oauth_error"] == ["microsoft_token_failed"]


@pytest.mark.asyncio
async def test_token_exchange_failure(monkeypatch):
    FakeMicrosoft(monkeypatch, token_status=400)
    response = await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")
    assert _query(response)["oauth_error"] == ["microsoft_token_failed"]


@pytest.mark.asyncio
async def test_graph_failure(monkeypatch):
    FakeMicrosoft(monkeypatch, me_status=500)
    response = await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")
    assert _query(response)["oauth_error"] == ["microsoft_userinfo_failed"]


@pytest.mark.asyncio
@pytest.mark.parametrize("me", [
    {"id": "oid-1", "displayName": "Sin correo"},
    {"id": "oid-1", "mail": "sin-arroba", "displayName": "X"},
    {"mail": "a@empresa.com", "displayName": "Sin id"},
])
async def test_an_account_without_email_or_id_is_refused(monkeypatch, me):
    FakeMicrosoft(monkeypatch, me=me)
    response = await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")
    assert _query(response)["oauth_error"] == ["microsoft_no_email"]
    oauth.users_repo.create_user.assert_not_called()


@pytest.mark.asyncio
async def test_a_server_error_never_leaks_the_exception_text(monkeypatch):
    FakeMicrosoft(monkeypatch, boom=RuntimeError("detalle-interno-secreto"))
    response = await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")

    assert _query(response)["oauth_error"] == ["microsoft_server_error"]
    assert "detalle-interno-secreto" not in response.headers["location"]


# ── reglas de cuenta ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_existing_active_user_is_linked_and_logged_in(monkeypatch):
    FakeMicrosoft(monkeypatch)
    oauth.users_repo.get_by_email.return_value = {"id": "u1", "email": "ana@empresa.com", "status": "active"}
    response = await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")

    assert _query(response)["oauth_access_token"] == ["access-token"]
    oauth.users_repo.create_user.assert_not_called()
    updates = oauth.users_repo.update.await_args.args[1]
    assert updates["microsoftId"] == "oid-1" and updates["provider"] == "microsoft"


@pytest.mark.asyncio
async def test_the_same_microsoft_identity_logs_in_again(monkeypatch):
    FakeMicrosoft(monkeypatch)
    oauth.users_repo.get_by_email.return_value = {
        "id": "u1", "email": "ana@empresa.com", "status": "active", "microsoftId": "oid-1",
        "provider": "microsoft", "authProvider": "microsoft"}
    response = await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")
    assert _query(response)["oauth_access_token"] == ["access-token"]


@pytest.mark.asyncio
async def test_the_email_alone_does_not_open_an_account_linked_to_another_identity(monkeypatch):
    FakeMicrosoft(monkeypatch)
    oauth.users_repo.get_by_email.return_value = {
        "id": "u1", "email": "ana@empresa.com", "status": "active", "microsoftId": "OTRO-oid"}
    response = await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")

    assert _query(response)["oauth_error"] == ["account_mismatch"]
    oauth.refresh_tokens_repo.create_token.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["disabled", "inactive", None])
async def test_an_inactive_account_cannot_log_in(monkeypatch, status):
    FakeMicrosoft(monkeypatch)
    oauth.users_repo.get_by_email.return_value = {"id": "u1", "email": "ana@empresa.com", "status": status}
    response = await oauth.microsoft_callback(_request(_cookie()), code="c", state="state-1")

    assert _query(response)["oauth_error"] == ["account_disabled"]
    oauth.refresh_tokens_repo.create_token.assert_not_called()


@pytest.mark.asyncio
async def test_the_same_rules_apply_to_google_accounts():
    oauth.users_repo.get_by_email.return_value = {"id": "u1", "email": "a@x.com", "status": "disabled"}
    with pytest.raises(oauth.OAuthRefused) as ei:
        await oauth._find_or_create_oauth_user("a@x.com", "A", "google", "g-1")
    assert ei.value.code == "account_disabled"

    oauth.users_repo.get_by_email.return_value = {"id": "u1", "email": "a@x.com", "status": "active", "googleId": "g-OTRO"}
    with pytest.raises(oauth.OAuthRefused) as ei:
        await oauth._find_or_create_oauth_user("a@x.com", "A", "google", "g-1")
    assert ei.value.code == "account_mismatch"
