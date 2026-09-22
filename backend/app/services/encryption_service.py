"""Symmetric encryption for secrets at rest (SMTP passwords, provider API keys).

Uses Fernet (AES-128-CBC + HMAC) with a dedicated key — PIPELINE_ENCRYPTION_KEY
— separate from APP_SECRET_KEY, which signs JWTs and has a different rotation
lifecycle. Never derive one from the other.
"""
from __future__ import annotations

from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


class EncryptionNotConfiguredError(RuntimeError):
    """Raised when PIPELINE_ENCRYPTION_KEY is missing or malformed."""


@lru_cache()
def _fernet() -> Fernet:
    key = settings.pipeline_encryption_key.strip()
    if not key:
        raise EncryptionNotConfiguredError(
            "PIPELINE_ENCRYPTION_KEY is not set. Generate one with "
            "`python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"` "
            "and set it in the environment before storing pipeline secrets."
        )
    try:
        return Fernet(key.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        raise EncryptionNotConfiguredError(
            "PIPELINE_ENCRYPTION_KEY is not a valid Fernet key."
        ) from exc


def encrypt(plaintext: str) -> str:
    """Encrypt a secret for storage. Returns an opaque token, safe to persist."""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt(token: str) -> str:
    """Decrypt a token produced by `encrypt`. Raises InvalidToken if it is
    corrupt or was encrypted with a different key."""
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        raise
