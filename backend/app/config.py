"""
Application settings loaded from environment variables.
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import List

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    llm_short_timeout_seconds: int = 20
    llm_default_timeout_seconds: int = 45
    llm_long_timeout_seconds: int = 90

    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    google_redirect_uri: str = ""
    microsoft_oauth_client_id: str = ""
    microsoft_oauth_client_secret: str = ""
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

    supabase_url: str = ""
    supabase_service_key: str = ""
    supabase_storage_bucket: str = "nd-assets"

    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/0"
    celery_result_backend: str = "redis://localhost:6379/1"

    @field_validator("backend_cors_origins")
    @classmethod
    def normalize_cors_origins(cls, value: str) -> str:
        return ",".join(origin.strip() for origin in value.split(",") if origin.strip())

    @model_validator(mode="after")
    def _require_real_secret_in_production(self) -> "Settings":
        if self.app_env.lower() == "production" and self.app_secret_key == "change-me-in-production":
            raise RuntimeError(
                "APP_SECRET_KEY is still set to the default 'change-me-in-production' value "
                "while APP_ENV=production. Set a strong, unique APP_SECRET_KEY before starting "
                "the application."
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
