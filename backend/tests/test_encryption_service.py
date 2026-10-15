"""Guards the encryption layer (SMTP passwords, API keys) across cryptography upgrades."""
from __future__ import annotations

import pytest
from cryptography.fernet import Fernet, InvalidToken

from app.services import encryption_service


@pytest.fixture
def fernet_key(monkeypatch):
    monkeypatch.setattr(
        encryption_service.settings, "pipeline_encryption_key", Fernet.generate_key().decode()
    )
    encryption_service._fernet.cache_clear()
    yield
    encryption_service._fernet.cache_clear()


def test_encrypt_decrypt_round_trip(fernet_key):
    token = encryption_service.encrypt("s3cret-ñ-pass")
    assert token != "s3cret-ñ-pass"
    assert encryption_service.decrypt(token) == "s3cret-ñ-pass"


def test_decrypt_rejects_token_from_another_key(fernet_key):
    foreign = Fernet(Fernet.generate_key()).encrypt(b"x").decode()
    with pytest.raises(InvalidToken):
        encryption_service.decrypt(foreign)


def test_decrypt_rejects_tampered_token(fernet_key):
    token = encryption_service.encrypt("abc")
    tampered = token[:-4] + ("AAAA" if not token.endswith("AAAA") else "BBBB")
    with pytest.raises(InvalidToken):
        encryption_service.decrypt(tampered)


def test_cryptography_version_has_no_known_advisories():
    import cryptography

    major = int(cryptography.__version__.split(".")[0])
    assert major >= 46  # 42.x has open PYSEC advisories fixed up to 46.0.6
