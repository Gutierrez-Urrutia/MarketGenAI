"""Cierre de RF-VTA-01: CP-100 (límites de la carga de documentos) y CP-004 (documentos sin relación
con el servicio pedido). Los nombres llevan el ID del caso de la matriz (CP-xxx)."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.services import rag_proposal_service as rag
from app.services.document_text_service import MAX_FILE_BYTES
from app.workers.tasks.proposal_tasks import _generate_proposal_content
from tests.conftest import FAKE_USER_SUB

API = "/api/v1/knowledge/documents"


@pytest.fixture
def manager(app):
    from app.dependencies.auth import CurrentUser, get_current_user
    original = app.dependency_overrides.get(get_current_user)
    base = original()  # type: ignore[misc]
    user = CurrentUser(**{**(base.model_dump() if hasattr(base, "model_dump") else vars(base)), "roles": ["manager"]})
    app.dependency_overrides[get_current_user] = lambda: user
    yield
    app.dependency_overrides[get_current_user] = original


def _txt(name: str, size: int = 10) -> tuple:
    return ("files", (name, b"a" * size, "text/plain"))


def _fake_doc(i: int) -> dict:
    return {"id": f"d{i}", "title": f"doc{i}.txt", "filename": f"doc{i}.txt", "fileType": "txt"}


# ── CP-100 · límites de la carga ──────────────────────────────────────────────
class TestCP100:
    async def test_CP_100_archivo_vacio_se_rechaza_con_mensaje(self, client, manager):
        with patch.object(rag.knowledge_documents_repo, "list", new_callable=AsyncMock, return_value=[]):
            resp = await client.post(API, files=[("files", ("vacio.txt", b"", "text/plain"))])
        assert resp.status_code == 422
        failed = resp.json()["detail"]["failed"]
        assert failed == [{"filename": "vacio.txt", "error": "El archivo está vacío."}]

    async def test_CP_100_archivo_de_mas_de_10_MB_se_rechaza_e_indica_el_limite(self, client, manager):
        assert MAX_FILE_BYTES == 10 * 1024 * 1024
        with (
            patch.object(rag.knowledge_documents_repo, "list", new_callable=AsyncMock, return_value=[]),
            patch.object(rag.knowledge_documents_repo, "create", new_callable=AsyncMock) as create,
        ):
            resp = await client.post(API, files=[_txt("grande.txt", MAX_FILE_BYTES + 1)])
        assert resp.status_code == 422
        assert "supera el máximo de 10 MB" in resp.json()["detail"]["failed"][0]["error"]
        create.assert_not_called()

    async def test_CP_100_archivo_de_exactamente_10_MB_se_acepta(self, client, manager):
        with (
            patch.object(rag.knowledge_documents_repo, "list", new_callable=AsyncMock, return_value=[]),
            patch.object(rag.knowledge_documents_repo, "create", new_callable=AsyncMock, return_value=_fake_doc(1)),
            patch.object(rag.knowledge_chunks_repo, "create", new_callable=AsyncMock),
        ):
            resp = await client.post(API, files=[_txt("justo.txt", MAX_FILE_BYTES)])
        assert resp.status_code == 201 and len(resp.json()["uploaded"]) == 1

    async def test_CP_100_once_archivos_en_una_carga_se_rechazan_sin_procesar_ninguno(self, client, manager):
        with patch.object(rag, "ingest_document", new_callable=AsyncMock) as ingest:
            resp = await client.post(API, files=[_txt(f"a{i}.txt") for i in range(11)])
        assert resp.status_code == 422
        assert resp.json()["detail"] == "Máximo 10 archivos por solicitud."
        ingest.assert_not_called()

    async def test_CP_100_diez_archivos_en_una_carga_se_aceptan(self, client, manager):
        docs = iter(_fake_doc(i) for i in range(10))
        with patch.object(rag, "ingest_document", new_callable=AsyncMock, side_effect=lambda **kw: next(docs)) as ingest:
            resp = await client.post(API, files=[_txt(f"a{i}.txt") for i in range(10)])
        assert resp.status_code == 201 and len(resp.json()["uploaded"]) == 10
        assert ingest.await_count == 10

    async def test_CP_100_al_llegar_a_200_documentos_se_rechaza_e_indica_el_maximo(self, client, manager):
        assert rag.MAX_DOCS_PER_USER == 200
        lleno = [_fake_doc(i) for i in range(200)]
        with (
            patch.object(rag.knowledge_documents_repo, "list", new_callable=AsyncMock, return_value=lleno) as lst,
            patch.object(rag.knowledge_documents_repo, "create", new_callable=AsyncMock) as create,
        ):
            resp = await client.post(API, files=[_txt("uno_mas.txt")])
        assert resp.status_code == 422
        assert resp.json()["detail"]["failed"][0]["error"] == "Máximo de 200 documentos alcanzado; elimina alguno."
        create.assert_not_called()
        assert lst.call_args.kwargs["filters"] == [("userId", "==", FAKE_USER_SUB)]  # cuenta solo los del usuario

    async def test_CP_100_con_199_documentos_todavia_se_puede_subir_uno_mas(self, client, manager):
        casi = [_fake_doc(i) for i in range(199)]
        with (
            patch.object(rag.knowledge_documents_repo, "list", new_callable=AsyncMock, return_value=casi),
            patch.object(rag.knowledge_documents_repo, "create", new_callable=AsyncMock, return_value=_fake_doc(200)),
            patch.object(rag.knowledge_chunks_repo, "create", new_callable=AsyncMock),
        ):
            resp = await client.post(API, files=[_txt("numero200.txt")])
        assert resp.status_code == 201

    async def test_CP_100_la_lista_informa_el_limite_de_tamano(self, client):
        with patch.object(rag.knowledge_documents_repo, "list", new_callable=AsyncMock, return_value=[]):
            resp = await client.get(API)
        assert resp.json()["maxFileBytes"] == MAX_FILE_BYTES

    async def test_CP_100_cada_situacion_dice_cual_es_el_limite_en_una_carga_mixta(self, client, manager):
        """Uno válido, uno vacío y uno demasiado grande en la misma carga: se guarda el válido e informa los otros."""
        with (
            patch.object(rag.knowledge_documents_repo, "list", new_callable=AsyncMock, return_value=[]),
            patch.object(rag.knowledge_documents_repo, "create", new_callable=AsyncMock, return_value=_fake_doc(1)),
            patch.object(rag.knowledge_chunks_repo, "create", new_callable=AsyncMock),
        ):
            resp = await client.post(API, files=[_txt("ok.txt", 50), _txt("vacio.txt", 0), _txt("enorme.txt", MAX_FILE_BYTES + 1)])
        body = resp.json()
        assert resp.status_code == 201 and len(body["uploaded"]) == 1
        errors = {f["filename"]: f["error"] for f in body["failed"]}
        assert errors["vacio.txt"] == "El archivo está vacío." and "10 MB" in errors["enorme.txt"]


# ── CP-004 · documentos sin relación con el servicio pedido ───────────────────
DOCS_BPO = [
    {"id": "a", "title": "Propuesta Cobranza Retail Mercantil", "service": "cobranza", "client": "Retail Mercantil"},
    {"id": "b", "title": "Propuesta Contact Center Banco Andino", "service": "contact center", "client": "Banco Andino"},
    {"id": "c", "title": "Propuesta Back Office Seguros Pacífico", "service": "back office", "client": "Seguros Pacífico"},
]
CHUNKS_BPO = [
    {"docId": "a", "text": "Cobranza telefónica temprana con 12 gestores para Retail Mercantil",
     "tokens": rag._tokens("Cobranza telefónica temprana con 12 gestores para Retail Mercantil")},
    {"docId": "b", "text": "Contact center 24x7 de atención al cliente para Banco Andino",
     "tokens": rag._tokens("Contact center 24x7 de atención al cliente para Banco Andino")},
    {"docId": "c", "text": "Back office de conciliación y siniestros para Seguros Pacífico",
     "tokens": rag._tokens("Back office de conciliación y siniestros para Seguros Pacífico")},
]


async def _context_for(service: str, client_name: str = "Zeta Alimentos"):
    with (
        patch.object(rag.knowledge_documents_repo, "list", new_callable=AsyncMock, return_value=DOCS_BPO),
        patch.object(rag.knowledge_chunks_repo, "list", new_callable=AsyncMock, return_value=CHUNKS_BPO),
    ):
        return await rag.get_rag_context_and_sources(FAKE_USER_SUB, client_name=client_name, service_type=service)


class TestCP004:
    async def test_CP_004_un_servicio_que_los_documentos_no_tratan_no_trae_fragmentos(self):
        context, sources = await _context_for("Ciberseguridad y monitoreo SOC 24x7")
        assert context == "" and sources == []

    async def test_CP_004_un_servicio_que_si_tratan_trae_solo_los_fragmentos_relacionados(self):
        context, sources = await _context_for("Cobranza telefónica de cartera")
        assert [s["title"] for s in sources] == ["Propuesta Cobranza Retail Mercantil"]
        assert "Cobranza telefónica temprana" in context
        assert "Banco Andino" not in context and "Seguros Pacífico" not in context  # no se cuela otro rubro

    async def test_CP_004_el_prompt_no_incluye_contexto_historico_ni_nombres_de_otros_clientes(self):
        with (
            patch("app.routers.proposals._output_dir", return_value=Path(__import__("tempfile").mkdtemp())),
            patch("app.routers.proposals.deepseek_service.generate_text", new_callable=AsyncMock, return_value="<p>ok</p>") as gen,
            patch.object(rag.knowledge_documents_repo, "list", new_callable=AsyncMock, return_value=DOCS_BPO),
            patch.object(rag.knowledge_chunks_repo, "list", new_callable=AsyncMock, return_value=CHUNKS_BPO),
        ):
            result = await _generate_proposal_content(
                "Propuesta de ciberseguridad", "Zeta Alimentos", "Monitoreo de seguridad SOC 24x7 y respuesta a incidentes",
                language="es", user_id=FAKE_USER_SUB,
            )
        prompt = gen.await_args.args[0]
        assert "CONTEXTO DE PROPUESTAS HISTÓRICAS" not in prompt
        for name in ("Retail Mercantil", "Banco Andino", "Seguros Pacífico"):
            assert name not in prompt
        assert result["sources"] == []  # el paso 3 no muestra «Fuentes usadas»

    async def test_CP_004_sin_ningun_documento_relacionado_tampoco_falla(self):
        with patch.object(rag.knowledge_documents_repo, "list", new_callable=AsyncMock, return_value=[]):
            assert await rag.get_rag_context_and_sources(FAKE_USER_SUB, client_name="X", service_type="Ciberseguridad") == ("", [])


class TestCP004RelevanciaMinima:
    """La regla MIN_QUERY_COVERAGE: ningún fragmento trata el servicio -> sin contexto; un cliente nuevo no resta."""

    def test_CP_004_un_termino_generico_en_comun_ya_no_basta(self):
        docs = {d["id"]: d for d in DOCS_BPO}
        # «24x7» está en el fragmento del contact center, pero el servicio pedido es otro.
        assert rag.rank_chunks("Ciberseguridad y monitoreo SOC 24x7", CHUNKS_BPO, docs, min_coverage=rag.MIN_QUERY_COVERAGE) == []
        assert rag.rank_chunks("Ciberseguridad y monitoreo SOC 24x7", CHUNKS_BPO, docs)  # sin la regla (RF-08) sigue como antes

    def test_CP_004_un_servicio_cubierto_sigue_trayendo_su_fragmento_aunque_el_cliente_sea_nuevo(self):
        docs = {d["id"]: d for d in DOCS_BPO}
        top = rag.rank_chunks("Cobranza telefónica temprana Zeta Alimentos", CHUNKS_BPO, docs, client_name="Zeta Alimentos", min_coverage=rag.MIN_QUERY_COVERAGE)
        assert [c["docId"] for c in top][0] == "a"

    def test_CP_004_el_umbral_existe_y_es_moderado(self):
        assert 0.1 <= rag.MIN_QUERY_COVERAGE <= 0.5


class TestCP004PisoRelativo:
    """Junto al fragmento que sí trata el servicio no se cuelan otros que solo comparten un par de términos."""

    CHUNKS = [
        {"docId": "a", "text": "Cobranza telefónica temprana con gestores y gestión de mora", "tokens": rag._tokens("Cobranza telefónica temprana con gestores y gestión de mora")},
        {"docId": "b", "text": "Back office de conciliación de pagos y seguimiento de mora", "tokens": rag._tokens("Back office de conciliación de pagos y seguimiento de mora")},
    ]
    DOCS = {"a": {"title": "Cobranza", "service": "cobranza"}, "b": {"title": "Back office", "service": "back office"}}
    QUERY = "Cobranza telefónica temprana y mora"

    def test_CP_004_con_la_regla_solo_queda_el_fragmento_relevante(self):
        top = rag.rank_chunks(self.QUERY, self.CHUNKS, self.DOCS, min_coverage=rag.MIN_QUERY_COVERAGE)
        assert [c["docId"] for c in top] == ["a"]

    def test_CP_004_sin_la_regla_todo_se_comporta_como_antes(self):
        """RF-08 no activa la regla: conserva su ranking."""
        top = rag.rank_chunks(self.QUERY, self.CHUNKS, self.DOCS)
        assert [c["docId"] for c in top] == ["a", "b"]

    def test_CP_004_el_piso_relativo_es_moderado(self):
        assert 0.2 <= rag.RELATIVE_COVERAGE_FLOOR <= 0.6
