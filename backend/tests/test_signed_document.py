"""RF-VTA-06 (etapa diferida): adjuntar y quitar el documento firmado de una propuesta.

El almacenamiento y el repositorio se reemplazan por dobles: se prueba lo que decide el router
(validación del archivo, propiedad, límite de uso), no Supabase ni Firestore.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from app.schemas.proposal import MAX_SIGNED_DOCUMENT_BYTES
from tests.test_proposal_status import API, REPO, OTHER_USER, fake_proposal

STORAGE = "app.routers.proposals.storage_service"
PDF = b"%PDF-1.4\n% documento firmado de prueba\n%%EOF\n"


def _upload(client, data: bytes, name: str = "contrato.pdf", proposal_id: str = "proposal-001"):
    return client.post(f"{API}/{proposal_id}/signed-document", files={"file": (name, data, "application/pdf")})


async def _post(client, doc, data: bytes, name: str = "contrato.pdf"):
    """Sube `data` y devuelve (respuesta, upload_bytes, update, delete_file)."""
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=doc),
        patch(f"{REPO}.update", new_callable=AsyncMock, side_effect=lambda _id, fields: {**doc, **fields}) as update,
        patch(f"{STORAGE}.upload_bytes", new_callable=AsyncMock, return_value="/api/v1/assets/local/x.pdf") as upload,
        patch(f"{STORAGE}.delete_file", new_callable=AsyncMock) as delete,
    ):
        resp = await _upload(client, data, name)
    return resp, upload, update, delete


async def test_upload_valid_pdf_stores_it_and_fills_the_document_fields(client):
    resp, upload, update, delete = await _post(client, fake_proposal({"proposal_status": "en_negociacion"}), PDF, "Contrato Acme.pdf")
    assert resp.status_code == 200
    upload.assert_awaited_once()
    assert upload.await_args.args[0] == PDF
    fields = update.await_args.args[1]
    assert fields["signedDocumentName"] == "Contrato Acme.pdf"
    assert fields["signedDocumentUrl"] == "/api/v1/assets/local/x.pdf"
    assert fields["signedDocumentPath"].startswith("proposals/proposal-001/signed/")
    assert fields["signedDocumentUploadedAt"]
    delete.assert_not_called()


async def test_upload_accepts_uppercase_extension(client):
    resp, *_ = await _post(client, fake_proposal(), PDF, "CONTRATO.PDF")
    assert resp.status_code == 200


async def test_upload_replacing_a_document_deletes_the_previous_file(client):
    doc = fake_proposal({"signedDocumentPath": "proposals/proposal-001/signed/viejo.pdf"})
    resp, _, _, delete = await _post(client, doc, PDF)
    assert resp.status_code == 200
    delete.assert_awaited_once_with("proposals/proposal-001/signed/viejo.pdf")


async def test_upload_rejects_non_pdf_extensions(client):
    for name in ("programa.exe", "contrato.docx", "foto.png", "sin_extension"):
        resp, upload, update, _ = await _post(client, fake_proposal(), PDF, name)
        assert resp.status_code == 422, name
        assert "Formato no soportado" in resp.json()["detail"]
        upload.assert_not_called()
        update.assert_not_called()


async def test_upload_rejects_content_that_is_not_a_pdf_even_with_pdf_extension(client):
    """RF06-D-001: la extensión la elige quien sube el archivo; hay que mirar el contenido."""
    falsos = [
        b"MZ\x90\x00This program cannot be run in DOS mode.",
        b"Esto es solo texto.",
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 50,
        b"<html><script>alert(1)</script></html>",
        b"",
    ]
    for data in falsos:
        resp, upload, update, _ = await _post(client, fake_proposal(), data, "contrato.pdf")
        assert resp.status_code == 422, data[:12]
        assert "PDF" in resp.json()["detail"]
        upload.assert_not_called()
        update.assert_not_called()


async def test_upload_does_not_delete_the_previous_document_when_the_new_one_is_rejected(client):
    doc = fake_proposal({"signedDocumentPath": "proposals/proposal-001/signed/viejo.pdf"})
    resp, _, update, delete = await _post(client, doc, b"no es un pdf")
    assert resp.status_code == 422
    delete.assert_not_called()
    update.assert_not_called()


async def test_upload_size_limit_is_exactly_10_mb(client):
    justo = PDF + b"x" * (MAX_SIGNED_DOCUMENT_BYTES - len(PDF))
    resp, *_ = await _post(client, fake_proposal(), justo)
    assert resp.status_code == 200
    resp, upload, update, _ = await _post(client, fake_proposal(), justo + b"x")
    assert resp.status_code == 422
    assert "10 MB" in resp.json()["detail"]
    upload.assert_not_called()
    update.assert_not_called()


async def test_upload_to_someone_elses_proposal_is_403(client):
    resp, upload, update, _ = await _post(client, fake_proposal({"userId": OTHER_USER}), PDF)
    assert resp.status_code == 403
    upload.assert_not_called()
    update.assert_not_called()


async def test_upload_to_a_missing_proposal_is_404(client):
    resp, upload, *_ = await _post(client, None, PDF)
    assert resp.status_code == 404
    upload.assert_not_called()


async def test_upload_is_limited_to_20_per_minute(client):
    codes = []
    doc = fake_proposal()
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=doc),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=doc),
        patch(f"{STORAGE}.upload_bytes", new_callable=AsyncMock, return_value="/u.pdf"),
        patch(f"{STORAGE}.delete_file", new_callable=AsyncMock),
    ):
        for _ in range(22):
            codes.append((await _upload(client, PDF)).status_code)
    assert codes[:20] == [200] * 20
    assert codes[20:] == [429, 429]


async def test_delete_signed_document_is_limited_to_20_per_minute(client):
    doc = fake_proposal({"proposal_status": "en_negociacion"})
    codes = []
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=doc),
        patch(f"{REPO}.update", new_callable=AsyncMock, return_value=doc),
        patch(f"{STORAGE}.delete_file", new_callable=AsyncMock),
    ):
        for _ in range(21):
            codes.append((await client.delete(f"{API}/proposal-001/signed-document")).status_code)
    assert codes[:20] == [200] * 20
    assert codes[20] == 429
