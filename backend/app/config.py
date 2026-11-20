"""
Application settings loaded from environment variables.
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import List

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Official Microsoft endpoints for the mailbox connection (see Settings.mail_*).
DEFAULT_MICROSOFT_LOGIN_BASE_URL = "https://login.microsoftonline.com"
DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"


def missing_required(s: "Settings") -> list[str]:
    """Variables obligatorias de producción que faltan o no sirven, cada una con el motivo (RNF-04).

    No exige credenciales de Firestore: en Cloud Run se usa la cuenta de servicio del servicio (ADC), sin archivo. Solo si se define
    FIREBASE_SERVICE_ACCOUNT_JSON se comprueba que sea un JSON válido."""
    problemas: list[str] = []
    if not s.app_secret_key or s.app_secret_key == "change-me-in-production":
        problemas.append("APP_SECRET_KEY (vacía o la de por defecto)")
    if not s.google_cloud_project:
        problemas.append("GOOGLE_CLOUD_PROJECT (proyecto de Firestore)")
    if not s.deepseek_api_key:
        problemas.append("DEEPSEEK_API_KEY (llave de la IA)")
    if not s.pipeline_encryption_key:
        problemas.append("PIPELINE_ENCRYPTION_KEY (llave Fernet de cifrado)")
    else:
        try:
            from cryptography.fernet import Fernet
            Fernet(s.pipeline_encryption_key.encode())
        except Exception:
            problemas.append("PIPELINE_ENCRYPTION_KEY (no es una llave Fernet válida)")
    storage = (s.storage_backend or "").lower()
    if storage == "supabase":
        problemas.append("STORAGE_BACKEND (Supabase ya no existe: usar gcs)")
    elif storage == "gcs" and not s.gcs_bucket:
        problemas.append("GCS_BUCKET (obligatoria con STORAGE_BACKEND=gcs)")
    if s.firebase_service_account_json:
        try:
            import json
            json.loads(s.firebase_service_account_json)
        except ValueError:
            problemas.append("FIREBASE_SERVICE_ACCOUNT_JSON (no es un JSON válido)")
    # El login con Microsoft es opcional: solo se exige completo cuando se activa con el ID de cliente.
    if s.microsoft_oauth_client_id:
        if not s.microsoft_oauth_client_secret:
            problemas.append("MICROSOFT_OAUTH_CLIENT_SECRET (obligatoria con MICROSOFT_OAUTH_CLIENT_ID)")
        if not s.microsoft_tenant_id:
            problemas.append("MICROSOFT_TENANT_ID (ID del directorio; obligatoria con MICROSOFT_OAUTH_CLIENT_ID)")
        else:
            try:
                import uuid
                uuid.UUID(s.microsoft_tenant_id.strip())
            except ValueError:
                problemas.append("MICROSOFT_TENANT_ID (debe ser el GUID del directorio, no su nombre)")
    return problemas


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "MarketGen AI"
    app_env: str = "development"
    app_debug: bool = True
    app_secret_key: str = "change-me-in-production"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 14
    password_reset_token_expire_minutes: int = 60
    local_dev_auth_enabled: bool = True
    local_dev_auth_email: str = "admin@noondalton.com"
    local_dev_auth_password: str = "admin123"
    local_dev_auth_name: str = "Admin User"
    rate_limit_enabled: bool = True
    audit_log_enabled: bool = True
    # RNF-02: solo confiar en X-Forwarded-For cuando la API corre detrás de un proxy propio.
    trust_proxy_headers: bool = False
    admin_emails: str = ""

    backend_cors_origins: str = (
        "http://localhost:5173,"
        "http://127.0.0.1:5173,"
        "https://marketgenai.vercel.app,"
        "https://market-gen-ai-6lzt.vercel.app"
    )

    google_cloud_project: str = ""
    google_application_credentials: str = ""
    firebase_credentials_path: str = ""
    firebase_service_account_json: str = ""
    firestore_database: str = "(default)"

    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-flash"
    gemini_api_key: str = ""
    gemini_default_model: str = "gemini-3.6-flash"
    llm_short_timeout_seconds: int | None = None
    llm_default_timeout_seconds: int | None = None
    llm_long_timeout_seconds: int | None = None

    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    google_redirect_uri: str = ""
    microsoft_oauth_client_id: str = ""
    microsoft_oauth_client_secret: str = ""
    # Login con Microsoft: solo entran las cuentas de este directorio (inquilino único) de Entra ID.
    microsoft_tenant_id: str = ""
    # Debe coincidir exacta con la URI registrada en Entra ID. Vacía: se arma con el host de la petición.
    microsoft_redirect_uri: str = ""
    oauth_redirect_base_url: str = "http://127.0.0.1:8000/api/v1"
    frontend_url: str = "http://localhost:5173"

    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_redirect_uri: str = ""
    meta_graph_api_version: str = "v21.0"
    meta_access_token: str = ""

    linkedin_access_token: str = ""

    twitter_client_id: str = ""
    twitter_client_secret: str = ""
    twitter_api_key: str = ""
    twitter_api_secret: str = ""

    keycloak_url: str = "http://localhost:8080"
    keycloak_realm: str = "nd-marketing"
    keycloak_client_id: str = "nd-backend"
    keycloak_client_secret: str = ""

    hubspot_base_url: str = "https://api.hubapi.com"
    salesforce_api_version: str = "v61.0"

    supabase_url: str = ""
    supabase_service_key: str = ""
    supabase_storage_bucket: str = "nd-assets"

    # Dónde se guardan los archivos generados: "supabase" (por defecto, comportamiento histórico) o "gcs"
    # (Google Cloud Storage, con gcs_bucket). Con "gcs" una falla de subida NO cae al disco local: en la
    # nube la API y el worker son máquinas distintas y un archivo local no lo vería la otra.
    storage_backend: str = "supabase"
    gcs_bucket: str = ""

    # Fernet key encrypting pipeline secrets at rest (provider API keys, the
    # mailbox OAuth tokens) — see app/services/encryption_service.py.
    # Deliberately not derived from app_secret_key: different blast radius and
    # rotation needs.
    pipeline_encryption_key: str = ""

    # Real sending of prospecting emails from the platform (RF-VTA-16). Master
    # switch for the whole deployment: off by default, and each user must also
    # switch it on in their pipeline config. Both are required to send.
    outreach_real_send_enabled: bool = False
    # Sandbox (local and dev). When set -- addresses separated by commas; from Secret Manager in dev, from .env
    # locally -- EVERY prospecting email is delivered to these addresses and never to the contact's real one. It is
    # the switch that tells a test environment from a real one: leave it empty only where real prospects should be
    # written to. A value that is set but has no valid address blocks sending (it never falls back to the contact).
    outreach_redirect_to: str = ""

    # Sending from each user's own Microsoft 365 / Outlook mailbox (RF-VTA-16):
    # delegated OAuth (authorization code + PKCE) and Microsoft Graph. Its own
    # app registration, apart from the login one (microsoft_oauth_*), so that
    # signing in never asks for mail permissions.
    mail_oauth_client_id: str = ""
    mail_oauth_client_secret: str = ""
    # Must match the redirect URI registered in Entra ID exactly.
    mail_oauth_redirect_url: str = "http://localhost:8000/api/v1/mail-connection/callback"
    microsoft_login_base_url: str = DEFAULT_MICROSOFT_LOGIN_BASE_URL
    graph_base_url: str = DEFAULT_GRAPH_BASE_URL
    # Development/test only: lets the two URLs above point somewhere else
    # (e.g. the local fake Graph). Never honoured when APP_ENV=production.
    mail_allow_custom_endpoints: bool = False
    # Time budget of one HTTP call to Microsoft or Google (login, Graph or Gmail).
    mail_http_timeout_seconds: float = 20.0
    # Sending from the user's own Gmail mailbox: same OAuth client as the Google login (google_oauth_client_id /
    # google_oauth_client_secret). Must match a redirect URI registered in that client exactly.
    mail_google_redirect_url: str = "http://127.0.0.1:8000/api/v1/mail-connection/google/callback"

    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/0"
    celery_result_backend: str = "redis://localhost:6379/1"

    @field_validator("backend_cors_origins")
    @classmethod
    def normalize_cors_origins(cls, value: str) -> str:
        return ",".join(origin.strip() for origin in value.split(",") if origin.strip())

    @model_validator(mode="after")
    def _require_mandatory_in_production(self) -> "Settings":
        # RNF-04: el arranque informa TODAS las obligatorias que faltan, no solo la primera ni la que falle más tarde.
        if self.app_env.lower() == "production":
            faltantes = missing_required(self)
            if faltantes:
                raise RuntimeError(
                    "Faltan variables de entorno obligatorias con APP_ENV=production: "
                    + "; ".join(faltantes)
                    + ". Ver docs/MANUAL-DESPLIEGUE.md, sección 3."
                )
        return self

    @model_validator(mode="after")
    def _official_mail_endpoints_in_production(self) -> "Settings":
        if self.app_env.lower() == "production" and (
            self.microsoft_login_base_url.rstrip("/") != DEFAULT_MICROSOFT_LOGIN_BASE_URL
            or self.graph_base_url.rstrip("/") != DEFAULT_GRAPH_BASE_URL
        ):
            raise RuntimeError(
                "MICROSOFT_LOGIN_BASE_URL / GRAPH_BASE_URL point to non-official endpoints "
                "while APP_ENV=production. Remove them: custom endpoints (the local fake "
                "Graph) are for development and tests only."
            )
        return self

    @property
    def cors_origins(self) -> List[str]:
        return [origin.strip() for origin in self.backend_cors_origins.split(",") if origin.strip()]

    @property
    def effective_backend_url(self) -> str:
        # VERCEL_PROJECT_PRODUCTION_URL is the stable custom domain on Vercel
        prod_url = os.environ.get("VERCEL_PROJECT_PRODUCTION_URL", "")
        if prod_url:
            return f"https://{prod_url}/api/v1"
        return self.oauth_redirect_base_url

    @property
    def effective_frontend_url(self) -> str:
        prod_url = os.environ.get("VERCEL_PROJECT_PRODUCTION_URL", "")
        if prod_url:
            return f"https://{prod_url}"
        return self.frontend_url

    @property
    def keycloak_jwks_url(self) -> str:
        return (
            f"{self.keycloak_url}/realms/{self.keycloak_realm}"
            "/protocol/openid-connect/certs"
        )

    @property
    def keycloak_issuer(self) -> str:
        return f"{self.keycloak_url}/realms/{self.keycloak_realm}"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

