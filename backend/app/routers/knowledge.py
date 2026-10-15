"""
Base de conocimiento para propuestas (RF-VTA-01).

Endpoints:
  GET    /knowledge/documents                 — lista los documentos cargados
  POST   /knowledge/documents                 — sube uno o varios archivos (pdf, docx, csv, xlsx, txt, md)
  DELETE /knowledge/documents/{doc_id}        — elimina un documento y sus fragmentos

Cargar y eliminar requiere rol manager o admin; listar, cualquier usuario autenticado.
"""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.core.rbac import require_role
from app.dependencies.auth import CurrentUser, get_current_user
from app.services import rag_proposal_service
from app.services.document_text_service import (
    MAX_FILE_BYTES,
    SUPPORTED_EXTENSIONS,
    DocumentExtractionError,
)
from app.services.firestore_service import knowledge_documents_repo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/knowledge", tags=["Knowledge"])

MAX_FILES_PER_REQUEST = 10


def _public(doc: dict) -> dict:
    return {k: doc.get(k) for k in (
        "id", "title", "filename", "fileType", "service", "client",
        "sizeBytes", "chunkCount", "status", "createdAt",
    )}


@router.get("/documents")
async def list_documents(user: CurrentUser = Depends(get_current_user)):
    docs = await knowledge_documents_repo.list(
        filters=[("userId", "==", user.sub)],
        order_by="createdAt", order_direction="DESCENDING", limit=rag_proposal_service.MAX_DOCS_PER_USER,
    )
    return {
        "items": [_public(d) for d in docs],
        "total": len(docs),
        "supportedExtensions": sorted(SUPPORTED_EXTENSIONS),
        "maxFileBytes": MAX_FILE_BYTES,
    }


@router.post("/documents", status_code=status.HTTP_201_CREATED)
async def upload_documents(
    files: List[UploadFile] = File(...),
    service: Optional[str] = Form(None),
    client: Optional[str] = Form(None),
    user: CurrentUser = Depends(get_current_user),
):
    """Procesa cada archivo por separado: uno inválido no impide guardar los demás."""
    require_role("manager")(user)
    if len(files) > MAX_FILES_PER_REQUEST:
        raise HTTPException(status_code=422, detail=f"Máximo {MAX_FILES_PER_REQUEST} archivos por solicitud.")

    uploaded, failed = [], []
    for f in files:
        name = f.filename or "archivo"
        data = await f.read(MAX_FILE_BYTES + 1)  # lee 1 byte de más para detectar exceso sin cargar todo
        try:
            doc = await rag_proposal_service.ingest_document(
                user_id=user.sub, filename=name, data=data, service=service, client=client,
            )
            uploaded.append(_public(doc))
        except (DocumentExtractionError, ValueError) as exc:
            failed.append({"filename": name, "error": str(exc)})
        except Exception:
            logger.exception("knowledge upload failed: %s", name)
            failed.append({"filename": name, "error": "Error interno al procesar el archivo."})

    if not uploaded:
        raise HTTPException(status_code=422, detail={"message": "Ningún archivo pudo procesarse.", "failed": failed})
    return {"uploaded": uploaded, "failed": failed}


@router.delete("/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(doc_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role("manager")(user)
    doc = await knowledge_documents_repo.get(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Documento no encontrado.")
    if doc.get("userId") != user.sub:
        raise HTTPException(status_code=403, detail="Access denied.")
    await rag_proposal_service.delete_document(doc_id)
