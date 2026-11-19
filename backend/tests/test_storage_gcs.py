"""Almacenamiento en Google Cloud Storage (STORAGE_BACKEND=gcs). Todo simulado: no toca la nube."""
from unittest.mock import MagicMock

import pytest
from google.api_core.exceptions import NotFound

from app.services import storage_service as st


@pytest.fixture
def gcs(monkeypatch):
    monkeypatch.setattr(st.settings, "storage_backend", "gcs")
    monkeypatch.setattr(st.settings, "gcs_bucket", "bucket-de-prueba")
    monkeypatch.setattr(st, "_gcs_client", None)


def _bucket(monkeypatch):
    bucket = MagicMock()
    monkeypatch.setattr(st, "_gcs_bucket", lambda: bucket)
    return bucket


class TestBackendSelection:
    def test_default_is_supabase(self, monkeypatch):
        monkeypatch.setattr(st.settings, "storage_backend", "supabase")
        assert st._use_gcs() is False

    def test_gcs_is_selected_ignoring_case_and_spaces(self, monkeypatch):
        monkeypatch.setattr(st.settings, "storage_backend", "  GCS ")
        assert st._use_gcs() is True

    def test_empty_value_means_supabase(self, monkeypatch):
        monkeypatch.setattr(st.settings, "storage_backend", "")
        assert st._use_gcs() is False

    def test_gcs_without_bucket_fails_clearly(self, gcs, monkeypatch):
        monkeypatch.setattr(st.settings, "gcs_bucket", "")
        with pytest.raises(RuntimeError, match="GCS_BUCKET"):
            st._gcs_bucket()


class TestUpload:
    def test_uploads_bytes_with_the_guessed_content_type_and_returns_a_signed_url(self, gcs, monkeypatch):
        bucket = _bucket(monkeypatch)
        monkeypatch.setattr(st, "_gcs_signed_url", lambda path, secs: f"https://firmada/{path}?e={secs}")
        url = st._upload_bytes_sync(b"%PDF-1.4", "assets/a1.whitepaper.pdf")
        bucket.blob.assert_called_once_with("assets/a1.whitepaper.pdf")
        bucket.blob.return_value.upload_from_string.assert_called_once_with(b"%PDF-1.4", content_type="application/pdf")
        assert url == "https://firmada/assets/a1.whitepaper.pdf?e=3600"

    def test_explicit_content_type_wins(self, gcs, monkeypatch):
        bucket = _bucket(monkeypatch)
        monkeypatch.setattr(st, "_gcs_signed_url", lambda path, secs: "https://firmada")
        st._upload_bytes_sync(b"x", "a/b.bin", "image/png")
        assert bucket.blob.return_value.upload_from_string.call_args.kwargs["content_type"] == "image/png"

    def test_a_failed_upload_raises_and_never_falls_back_to_local_disk(self, gcs, monkeypatch, tmp_path):
        """Con dos máquinas (API y worker) un archivo local no lo vería la otra: mejor fallar a la vista."""
        bucket = _bucket(monkeypatch)
        bucket.blob.return_value.upload_from_string.side_effect = RuntimeError("sin permiso")
        monkeypatch.chdir(tmp_path)
        # RNF-04: falla a la vista como StorageError (un RuntimeError) con un mensaje fijo; el detalle real queda como causa y en el log
        with pytest.raises(st.StorageError) as ei:
            st._upload_bytes_sync(b"x", "assets/a.pdf")
        assert "sin permiso" not in str(ei.value) and "sin permiso" in str(ei.value.__cause__)
        assert not (tmp_path / "generated_files").exists()

    def test_upload_file_reads_the_file_and_uploads_it(self, gcs, monkeypatch, tmp_path):
        bucket = _bucket(monkeypatch)
        monkeypatch.setattr(st, "_gcs_signed_url", lambda path, secs: "https://firmada")
        f = tmp_path / "x.pdf"
        f.write_bytes(b"contenido")
        st._upload_file_sync(str(f), "books/b1/exports/x.pdf")
        bucket.blob.return_value.upload_from_string.assert_called_once_with(b"contenido", content_type="application/pdf")


class TestSignedUrl:
    def test_signs_with_the_platform_service_account_through_iam(self, gcs, monkeypatch):
        creds = MagicMock(service_account_email="api@proyecto.iam.gserviceaccount.com", token="tok-123")
        monkeypatch.setattr("google.auth.default", lambda scopes=None: (creds, "proyecto"))
        bucket = _bucket(monkeypatch)
        bucket.blob.return_value.generate_signed_url.return_value = "https://storage.googleapis.com/firmada"

        url = st._get_signed_url_sync("assets/a.pdf", 600)

        creds.refresh.assert_called_once()
        kwargs = bucket.blob.return_value.generate_signed_url.call_args.kwargs
        assert kwargs["version"] == "v4" and kwargs["method"] == "GET"
        assert kwargs["expiration"].total_seconds() == 600
        assert kwargs["service_account_email"] == "api@proyecto.iam.gserviceaccount.com"
        assert kwargs["access_token"] == "tok-123"
        assert url == "https://storage.googleapis.com/firmada"


class TestDelete:
    def test_deletes_the_object(self, gcs, monkeypatch):
        bucket = _bucket(monkeypatch)
        st._delete_file_sync("assets/a.pdf")
        bucket.blob.assert_called_once_with("assets/a.pdf")
        bucket.blob.return_value.delete.assert_called_once()

    def test_missing_object_is_not_an_error(self, gcs, monkeypatch):
        bucket = _bucket(monkeypatch)
        bucket.blob.return_value.delete.side_effect = NotFound("no existe")
        st._delete_file_sync("assets/a.pdf")  # no lanza

    def test_other_errors_do_surface(self, gcs, monkeypatch):
        bucket = _bucket(monkeypatch)
        bucket.blob.return_value.delete.side_effect = RuntimeError("sin permiso")
        with pytest.raises(RuntimeError):
            st._delete_file_sync("assets/a.pdf")
