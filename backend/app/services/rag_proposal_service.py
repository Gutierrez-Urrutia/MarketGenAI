"""
RAG de propuestas históricas (RF-VTA-01).

La empresa carga sus propuestas (PDF, Word, CSV, Excel) como "base de conocimiento".
Cada archivo se fragmenta y se guarda en Firestore; al generar una propuesta se
recuperan los fragmentos más relevantes para el cliente y el servicio pedidos.

La recuperación es léxica (TF-IDF simplificado sobre los fragmentos del usuario),
sin dependencia de un servicio de embeddings.
"""
from __future__ import annotations

import asyncio
import math
import re
import unicodedata
from collections import Counter
from typing import Any

from app.services.document_text_service import extract_text
from app.services.firestore_service import (
    knowledge_chunks_repo,
    knowledge_documents_repo,
    new_id,
)

CHUNK_SIZE = 1200
CHUNK_OVERLAP = 150
MAX_CHUNKS_PER_DOC = 400
MAX_DOCS_PER_USER = 200
TOP_K = 5
MAX_CONTEXT_CHARS = 6000
_MAX_CHUNKS_SCANNED = 5000

_STOPWORDS = frozenset(
    "de la el en y a los las del un una por con para que se su al lo como mas o es "
    "the of and to in for with on is are an be by from this that or at as it".split()
)


def _tokens(text: str) -> list[str]:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return [t for t in re.findall(r"[a-z0-9]{3,}", text) if t not in _STOPWORDS]


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Agrupa párrafos hasta ~size caracteres; los párrafos enormes se parten con solape."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        while len(para) > size:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(para[:size])
            para = para[size - overlap:]
        if current and len(current) + len(para) + 2 > size:
            chunks.append(current)
            # el último fragmento arrastra un solape para no perder contexto
            current = current[-overlap:] + "\n\n" + para if overlap else para
        else:
            current = f"{current}\n\n{para}" if current else para
    if current:
        chunks.append(current)
    return chunks[:MAX_CHUNKS_PER_DOC]


# ── Ingesta ───────────────────────────────────────────────────────────────────
async def ingest_document(
    *,
    user_id: str,
    filename: str,
    data: bytes,
    title: str | None = None,
    service: str | None = None,
    client: str | None = None,
) -> dict[str, Any]:
    """Extrae, fragmenta e indexa un archivo. Lanza DocumentExtractionError si no es válido."""
    existing = await knowledge_documents_repo.list(
        filters=[("userId", "==", user_id)], limit=MAX_DOCS_PER_USER + 1
    )
    if len(existing) >= MAX_DOCS_PER_USER:
        raise ValueError(f"Máximo de {MAX_DOCS_PER_USER} documentos alcanzado; elimina alguno.")

    # La extracción es CPU-bound (PDF/Excel grandes): fuera del event loop.
    text, ext = await asyncio.to_thread(extract_text, filename, data)
    chunks = chunk_text(text)

    doc = await knowledge_documents_repo.create({
        "userId": user_id,
        "filename": filename,
        "title": (title or "").strip() or filename,
        "service": (service or "").strip(),
        "client": (client or "").strip(),
        "fileType": ext.lstrip("."),
        "sizeBytes": len(data),
        "charCount": len(text),
        "chunkCount": len(chunks),
        "status": "ready",
    })
    for i in range(0, len(chunks), 50):
        await asyncio.gather(*(
            knowledge_chunks_repo.create({
                "docId": doc["id"],
                "userId": user_id,
                "index": n,
                "text": chunk,
                "tokens": _tokens(chunk),
            }, doc_id=new_id())
            for n, chunk in enumerate(chunks[i:i + 50], start=i)
        ))
    return doc


async def delete_document(doc_id: str) -> None:
    chunks = await knowledge_chunks_repo.list(
        filters=[("docId", "==", doc_id)], limit=MAX_CHUNKS_PER_DOC + 1
    )
    await asyncio.gather(*(knowledge_chunks_repo.delete(c["id"]) for c in chunks))
    await knowledge_documents_repo.delete(doc_id)


# ── Recuperación ──────────────────────────────────────────────────────────────
def rank_chunks(
    query: str,
    chunks: list[dict[str, Any]],
    docs_by_id: dict[str, dict[str, Any]],
    *,
    client_name: str = "",
    top_k: int = TOP_K,
) -> list[dict[str, Any]]:
    """Ordena fragmentos por relevancia; devuelve [] si ninguno comparte términos con la consulta."""
    q_terms = set(_tokens(query))
    if not q_terms or not chunks:
        return []

    n = len(chunks)
    df: Counter[str] = Counter()
    for c in chunks:
        df.update(set(c.get("tokens") or []) & q_terms)
    idf = {t: math.log(1 + n / (1 + df[t])) for t in q_terms}

    service_terms = q_terms
    client_terms = set(_tokens(client_name))
    scored = []
    for c in chunks:
        toks = c.get("tokens") or []
        if not toks:
            continue
        tf = Counter(toks)
        score = sum(idf[t] * (1 + math.log(tf[t])) for t in q_terms if t in tf)
        if score <= 0:
            continue
        score /= math.sqrt(len(toks))

        doc = docs_by_id.get(c.get("docId"), {})
        # Los metadatos del documento pesan: el contexto "depende del cliente y del servicio".
        if service_terms & set(_tokens(f"{doc.get('service', '')} {doc.get('title', '')}")):
            score *= 1.5
        if client_terms and client_terms & set(_tokens(doc.get("client", ""))):
            score *= 1.3
        scored.append((score, c))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in scored[:top_k]]


async def retrieve_sources(
    user_id: str | None,
    client_name: str = "",
    service_type: str = "",
    extra_query: str = "",
) -> list[dict[str, str]]:
    """Fragmentos más relevantes del usuario como [{docId, title, text}], dentro del presupuesto
    de caracteres. Lista vacía si no hay documentos relevantes."""
    if not user_id:
        return []
    docs = await knowledge_documents_repo.list(
        filters=[("userId", "==", user_id)], limit=MAX_DOCS_PER_USER
    )
    if not docs:
        return []
    chunks = await knowledge_chunks_repo.list(
        filters=[("userId", "==", user_id)], limit=_MAX_CHUNKS_SCANNED
    )
    docs_by_id = {d["id"]: d for d in docs}
    query = " ".join(filter(None, [service_type, extra_query, client_name]))
    top = rank_chunks(query, chunks, docs_by_id, client_name=client_name)

    sources, used = [], 0
    for c in top:
        title = docs_by_id.get(c["docId"], {}).get("title", "documento")
        if used + len(title) + len(c["text"]) > MAX_CONTEXT_CHARS:
            break
        sources.append({"docId": c["docId"], "title": title, "text": c["text"]})
        used += len(title) + len(c["text"])
    return sources


async def get_rag_context(
    user_id: str | None,
    client_name: str = "",
    service_type: str = "",
    extra_query: str = "",
) -> str:
    """Contexto para el prompt de generación; cadena vacía si el usuario no cargó documentos
    relevantes (no se inventa un contexto de relleno)."""
    sources = await retrieve_sources(user_id, client_name, service_type, extra_query)
    if not sources:
        return ""
    blocks = [f"[Fuente: {s['title']}]\n{s['text']}" for s in sources]
    return (
        "CONTEXTO DE PROPUESTAS HISTÓRICAS DE LA EMPRESA:\n"
        "Los siguientes extractos provienen de propuestas reales cargadas por la empresa. "
        "Úsalos como referencia de servicios, estilo, estructura y tono. No copies datos de "
        "otros clientes (nombres, precios, cifras) a esta propuesta.\n\n"
        + "\n\n---\n\n".join(blocks)
        + "\n"
    )
