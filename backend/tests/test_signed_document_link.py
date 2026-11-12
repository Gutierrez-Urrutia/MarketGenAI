"""RF-VTA-06: el documento firmado se ve con un enlace temporal; la URL del archivo no se expone (P-9),
el archivo se borra con la propuesta (R-08) y las rutas del adjunto tienen etiquetas de auditoría propias (P-7)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from jose import jwt

from app.config import settings
from app.services.auth_service import JWT_ALGORITHM
from tests.test_proposal_status import API, REPO, OTHER_USER, FakeStatusStore, _patch_status, as_user, fake_proposal  # noqa: F401 (fixture)

STORAGE = "app.routers.proposals.storage_service"
PDF = b"%PDF-1.4\n% documento firmado de prueba\n%%EOF\n"
PATH = "proposals/proposal-001/signed/abc.pdf"
LINKED = {"proposal_status": "en_negociacion", "signedDocumentPath": PATH, "signedDocumentName": "contrato.pdf",
          "signedDocumentUrl": "https://x.supabase.co/public/proposals/proposal-001/signed/abc.pdf"}


async def test_proposal_responses_hide_the_document_location_and_flag_its_existence(client):
    with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal(LINKED)):
        body = (await client.get(f"{API}/proposal-001")).json()
    assert body["hasSignedDocument"] is True
    assert body["signedDocumentName"] == "contrato.pdf"
    assert "signedDocumentUrl" not in body and "signedDocumentPath" not in body
    with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()):
        assert (await client.get(f"{API}/proposal-001")).json()["hasSignedDocument"] is False


async def test_status_change_response_also_hides_the_document_location(client, as_user):
    as_user(["user"])
    store = FakeStatusStore(fake_proposal(LINKED))
    resp, *_ = await _patch_status(client, store, "firmada")
    body = resp.json()
    assert body["proposal_status"] == "firmada" and body["hasSignedDocument"] is True
    assert "signedDocumentUrl" not in body and "signedDocumentPath" not in body


async def test_link_for_supabase_document_is_a_temporary_signed_url(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal(LINKED)),
        patch(f"{STORAGE}.get_signed_url", new_callable=AsyncMock, return_value="https://x.supabase.co/sign/abc?token=t") as sign,
    ):
        resp = await client.get(f"{API}/proposal-001/signed-document/link")
    assert resp.status_code == 200
    assert resp.json() == {"url": "https://x.supabase.co/sign/abc?token=t", "expiresIn": 300, "name": "contrato.pdf"}
    sign.assert_awaited_once_with(PATH, 300)


async def test_link_refuses_to_fall_back_to_the_public_local_url(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal(LINKED)),
        patch(f"{STORAGE}.get_signed_url", new_callable=AsyncMock, return_value=f"/api/v1/assets/local/{PATH}"),
    ):
        resp = await client.get(f"{API}/proposal-001/signed-document/link")
    assert resp.status_code == 502


async def test_link_requires_a_document_and_ownership(client):
    with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()):
        assert (await client.get(f"{API}/proposal-001/signed-document/link")).status_code == 404
    with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal({**LINKED, "userId": OTHER_USER})):
        assert (await client.get(f"{API}/proposal-001/signed-document/link")).status_code == 403


async def test_local_document_link_serves_the_file_and_stops_working_when_replaced(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    target = tmp_path / "generated_files" / PATH
    target.parent.mkdir(parents=True)
    target.write_bytes(PDF)
    with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal(LINKED)):
        url = (await client.get(f"{API}/proposal-001/signed-document/link")).json()["url"]
        assert url.startswith("/api/v1/proposals/proposal-001/signed-document/file?token=")
        ok = await client.get(url)                       # sin Authorization: el token es la credencial
        assert ok.status_code == 200 and ok.content == PDF and "pdf" in ok.headers["content-type"]
        assert (await client.get(url + "x")).status_code == 403                                   # token alterado
        assert (await client.get(f"{API}/proposal-001/signed-document/file")).status_code == 422   # sin token
    replaced = fake_proposal({**LINKED, "signedDocumentPath": "proposals/proposal-001/signed/otro.pdf"})
    with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=replaced):
        assert (await client.get(url)).status_code == 403                                         # se reemplazó el documento
    with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()):
        assert (await client.get(url)).status_code == 403                                         # se quitó el documento


async def test_link_token_of_another_proposal_kind_or_expired_is_rejected(client):
    now = datetime.now(timezone.utc)
    valid = {"typ": "signed-document", "pid": "proposal-001", "path": PATH, "exp": now + timedelta(minutes=5)}
    for claims in ({**valid, "typ": "access"}, {**valid, "pid": "otra"}, {**valid, "exp": now - timedelta(seconds=5)}):
        token = jwt.encode(claims, settings.app_secret_key, algorithm=JWT_ALGORITHM)
        with patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal(LINKED)):
            assert (await client.get(f"{API}/proposal-001/signed-document/file?token={token}")).status_code == 403


async def test_public_local_asset_route_does_not_serve_signed_documents(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    signed = tmp_path / "generated_files" / PATH
    signed.parent.mkdir(parents=True)
    signed.write_bytes(PDF)
    other = tmp_path / "generated_files" / "assets" / "logo.png"
    other.parent.mkdir(parents=True)
    other.write_bytes(b"png")
    assert (await client.get(f"/api/v1/assets/local/{PATH}")).status_code == 404
    assert (await client.get("/api/v1/assets/local/assets/logo.png")).status_code == 200


async def test_deleting_a_proposal_deletes_its_signed_document_file(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal(LINKED)),
        patch(f"{REPO}.delete", new_callable=AsyncMock) as delete_doc,
        patch(f"{STORAGE}.delete_file", new_callable=AsyncMock) as delete_file,
    ):
        resp = await client.delete(f"{API}/proposal-001")
    assert resp.status_code == 204
    delete_file.assert_awaited_once_with(PATH)
    delete_doc.assert_awaited_once_with("proposal-001")


async def test_deleting_a_proposal_without_document_does_not_touch_storage(client):
    with (
        patch(f"{REPO}.get", new_callable=AsyncMock, return_value=fake_proposal()),
        patch(f"{REPO}.delete", new_callable=AsyncMock),
        patch(f"{STORAGE}.delete_file", new_callable=AsyncMock) as delete_file,
    ):
        assert (await client.delete(f"{API}/proposal-001")).status_code == 204
    delete_file.assert_not_called()


def test_audit_labels_for_signed_document_routes_are_specific():
    from app.middleware.audit import _infer_action
    assert _infer_action("POST", "/api/v1/proposals/p1/signed-document") == "uploaded_signed_document"
    assert _infer_action("DELETE", "/api/v1/proposals/p1/signed-document") == "removed_signed_document"
    assert _infer_action("DELETE", "/api/v1/proposals/p1") == "deleted_proposal"
    assert _infer_action("POST", "/api/v1/proposals") == "created_proposal"
