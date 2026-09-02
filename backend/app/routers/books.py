"""
Endpoins Terminados:
Book Concepts router — full CRUD + chapter management + LLM generation.

Endpoints cubiertos (secciones 2 y 3):

  BOOK CONCEPTS (Sección 2)
  GET    /books                               2.1 list (paginado + filtrado)
  POST   /books                               2.2 create
  GET    /books/{id}                          2.3 get con capítulos
  PUT    /books/{id}                          2.4 update (partial)
  DELETE /books/{id}                          2.5 delete (cascade)

  CHAPTERS (Sección 3)
  POST   /books/{id}/chapters/generate        3.1 generar capítulos con LLM (async)
  POST   /books/{id}/chapters                 3.2 añadir capítulo manualmente
  PUT    /books/{id}/chapters/{cid}           3.3 actualizar capítulo
  PUT    /books/{id}/chapters/reorder         3.4 reordenar capítulos (bulk)
  DELETE /books/{id}/chapters/{cid}           3.5 eliminar capítulo

  CONTENT GENERATION (Sección 4)
  POST   /books/{id}/content/generate         4.1 generar contenido de todos los capítulos (async)
  POST   /books/{id}/chapters/{cid}/content/generate  4.2 regenerar un capítulo (async)
  POST   /books/{id}/chapters/{cid}/content/refine    4.3 refinar contenido (no guarda)
  PUT    /books/{id}/chapters/{cid}/content   4.4 guardar contenido del editor WYSIWYG
"""
from __future__ import annotations

import asyncio
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies.auth import CurrentUser, get_current_user
# app/routers/books.py

from app.schemas.book import (
    BookCreate, BookListResponse, BookUpdate,  # Quité BookOut
    ChapterContentSave, ChapterCreate, ChapterReorder, ChapterUpdate,  # Quité ChapterOut
    GenerateChaptersRequest, GenerateContentRequest, RefineContentRequest,
)
from app.schemas.job import JobAccepted
from app.services import book_ai_service
from app.services.firestore_service import books_repo, jobs_repo
from app.workers.tasks.content_tasks import (
    task_generate_chapters,
    task_generate_all_content,
    task_generate_single_chapter,
)

router = APIRouter(prefix="/books", tags=["Books"])


# ── Helpers internos ──────────────────────────────────────────────────────────

def _assert_owner(book: dict, user_id: str):
    """Lanza 403 si el book no pertenece al usuario autenticado."""
    if book.get("userId") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied."
        )


async def _get_book_for_user(book_id: str, user_id: str) -> dict:
    """Obtiene un book de Firestore y verifica ownership. Lanza 404 o 403 según corresponda."""
    try:
        book = await books_repo.get_or_404(book_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Book '{book_id}' not found."
        )
    _assert_owner(book, user_id)
    return book


async def _get_chapter_for_user(book_id: str, chapter_id: str, user_id: str) -> dict:
    """Verifica ownership del book y luego busca el capítulo. Lanza 404 si no existe."""
    await _get_book_for_user(book_id, user_id)
    chapters = await books_repo.get_chapters(book_id)
    chapter = next((c for c in chapters if c["id"] == chapter_id), None)
    if not chapter:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chapter '{chapter_id}' not found."
        )
    return chapter


def _enum_value(value):
    return getattr(value, "value", value)


async def _generate_chapters_now(job_id: str, book_id: str, book: dict, chapter_count: int, language: str = "en") -> None:
    await jobs_repo.update_progress(job_id, 10, "processing")
    chapters_data = await book_ai_service.generate_chapters(
        title=book["title"],
        description=book["description"],
        keywords=book.get("keywords", []),
        chapter_count=chapter_count,
        language=language,
    )

    await jobs_repo.update_progress(job_id, 60, "processing")
    for chapter in await books_repo.get_chapters(book_id):
        await books_repo.delete_chapter(book_id, chapter["id"])

    created = []
    for index, chapter in enumerate(chapters_data):
        created.append(await books_repo.create_chapter(book_id, {
            "title": chapter["title"],
            "description": chapter.get("description", ""),
            "orderIndex": index,
            "status": "pending",
            "wordCount": 0,
            "contentAvailable": False,
        }))

    await books_repo.update(book_id, {"status": "outlined"})
    await jobs_repo.complete_job(job_id, {"chapters": created, "bookStatus": "outlined"})


async def _generate_chapter_content_now(
    book_id: str,
    book: dict,
    chapter: dict,
    content_type,
    style,
    language: str = "en",
) -> dict:
    """Generate LLM content for a single chapter and persist it. Shared by
    the single-chapter fallback (_generate_single_chapter_now) and the
    per-chapter loop in _generate_all_content_now, so the generation +
    persistence logic lives in exactly one place."""
    content = await book_ai_service.generate_chapter_content(
        book_title=book["title"],
        book_description=book["description"],
        chapter_title=chapter["title"],
        chapter_description=chapter.get("description", ""),
        content_type=_enum_value(content_type),
        style=_enum_value(style),
        language=language,
    )
    text = re.sub(r"<[^>]+>", " ", content)
    return await books_repo.update_chapter(book_id, chapter["id"], {
        "content": content,
        "wordCount": len(text.split()),
        "status": "generated",
        "contentAvailable": True,
    })


async def _generate_single_chapter_now(
    job_id: str,
    book_id: str,
    book: dict,
    chapter: dict,
    content_type,
    style,
    language: str = "en",
) -> None:
    await jobs_repo.update_progress(job_id, 20, "processing")
    updated = await _generate_chapter_content_now(book_id, book, chapter, content_type, style, language)
    await jobs_repo.complete_job(job_id, {"chapter": updated})


async def _generate_all_content_now(
    job_id: str,
    book_id: str,
    book: dict,
    chapters: list[dict],
    content_type,
    style,
    language: str = "en",
) -> None:
    await jobs_repo.update_progress(job_id, 5, "processing")
    total = len(chapters)

    async def generate_one(chapter):
        try:
            await _generate_chapter_content_now(book_id, book, chapter, content_type, style, language)
            return {"ok": True, "chapterId": chapter["id"]}
        except Exception as exc:
            return {"ok": False, "chapterId": chapter["id"], "error": str(exc)}

    await jobs_repo.update_progress(job_id, 10, "processing")
    results = await asyncio.gather(*[generate_one(ch) for ch in chapters])
    await jobs_repo.update_progress(job_id, 90, "processing")

    errors = [r for r in results if not r["ok"]]
    if not errors:
        await books_repo.update(book_id, {"status": "generated"})

    await jobs_repo.complete_job(job_id, {
        "bookId": book_id,
        "chaptersOk": total - len(errors),
        "chaptersError": len(errors),
        "errors": errors,
    })


# =============================================================================
# SECCIÓN 2 — BOOK CONCEPTS CRUD
# =============================================================================

# ── 2.1 GET /books ────────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=BookListResponse,
    status_code=status.HTTP_200_OK,
    summary="2.1 Listar book concepts (paginado)",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        422: {"description": "VALIDATION_ERROR"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def list_books(
    page:   int            = Query(1,  ge=1,        description="Número de página"),
    limit:  int            = Query(20, ge=1, le=100, description="Resultados por página, máx 100"),
    status: Optional[str]  = Query(None,             description="Filtrar por: draft | outlined | generated | published"),
    search: Optional[str]  = Query(None,             description="Búsqueda parcial en título"),
    sort:   str            = Query("updatedAt",      description="Campo de ordenamiento"),
    order:  str            = Query("desc",           description="Dirección: asc | desc"),
    user:   CurrentUser    = Depends(get_current_user),
):
    """
    Devuelve lista paginada de todos los book concepts del usuario autenticado,
    ordenados por fecha de modificación (más recientes primero) por defecto.
    """
    offset = (page - 1) * limit
    books = await books_repo.list_by_user(
        user_id=user.sub,
        status=status,
        search=search,
        limit=limit,
        offset=offset,
    )
    total = await books_repo.count(
        filters=[("userId", "==", user.sub)]
        + ([("status", "==", status)] if status else [])
    )
    return BookListResponse(data=books, total=total, page=page, limit=limit)


# ── 2.2 POST /books ───────────────────────────────────────────────────────────

@router.post(
    "",
    response_model=dict,
    status_code=status.HTTP_201_CREATED,
    summary="2.2 Crear nuevo book concept",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        422: {"description": "VALIDATION_ERROR"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def create_book(
    body: BookCreate,
    user: CurrentUser = Depends(get_current_user),
):
    """
    Persiste un nuevo book concept en estado 'draft'.
    El campo description es el prompt maestro para la generación de capítulos.
    """
    book = await books_repo.create({
        "title":       body.title,
        "description": body.description,
        "keywords":    body.keywords,
        "status":      "draft",
        "userId":      user.sub,
    })
    return book


# ── 2.3 GET /books/{book_id} ──────────────────────────────────────────────────

@router.get(
    "/{book_id}",
    response_model=dict,
    status_code=status.HTTP_200_OK,
    summary="2.3 Obtener book concept con capítulos",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def get_book(
    book_id: str,
    user:    CurrentUser = Depends(get_current_user),
):
    """
    Devuelve el book concept completo con el array de capítulos ordenado
    por orderIndex. Incluye wordCount, status y contentAvailable por capítulo.
    """
    book = await _get_book_for_user(book_id, user.sub)
    book["chapters"] = await books_repo.get_chapters(book_id)
    return book


# ── 2.4 PUT /books/{book_id} ──────────────────────────────────────────────────

@router.put(
    "/{book_id}",
    response_model=dict,
    status_code=status.HTTP_200_OK,
    summary="2.4 Actualizar metadata del book concept",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        422: {"description": "VALIDATION_ERROR"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def update_book(
    book_id: str,
    body:    BookUpdate,
    user:    CurrentUser = Depends(get_current_user),
):
    """
    Actualización parcial — solo los campos presentes en el body son modificados.
    Cambiar description después de generar contenido NO regenera automáticamente
    los capítulos; el usuario debe disparar la regeneración explícitamente.
    """
    await _get_book_for_user(book_id, user.sub)
    update_data = body.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update."
        )
    return await books_repo.update(book_id, update_data)


# ── 2.5 DELETE /books/{book_id} ───────────────────────────────────────────────

@router.delete(
    "/{book_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="2.5 Eliminar book concept y todos sus recursos",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def delete_book(
    book_id: str,
    user:    CurrentUser = Depends(get_current_user),
):
    """
    Elimina en cascada: capítulos, contenido generado y assets asociados.
    OPERACIÓN IRREVERSIBLE.
    """
    await _get_book_for_user(book_id, user.sub)
    chapters = await books_repo.get_chapters(book_id)
    for ch in chapters:
        await books_repo.delete_chapter(book_id, ch["id"])
    await books_repo.delete(book_id)


# =============================================================================
# SECCIÓN 3 — CHAPTERS
# =============================================================================

# ── 3.1 POST /books/{book_id}/chapters/generate ───────────────────────────────

@router.post(
    "/{book_id}/chapters/generate",
    response_model=JobAccepted,
    status_code=status.HTTP_202_ACCEPTED,
    summary="3.1 Generar capítulos con LLM (async)",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        503: {"description": "LLM_UNAVAILABLE"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def generate_chapters_endpoint(
    book_id: str,
    body:    GenerateChaptersRequest,
    user:    CurrentUser = Depends(get_current_user),
):
    """
    Envía título, descripción y keywords del book al LLM para generar
    un outline de capítulos sugerido. Devuelve job_id para polling.
    Reemplaza cualquier capítulo existente.
    """
    book = await _get_book_for_user(book_id, user.sub)
    job = await jobs_repo.create_job(
        job_type="generate_chapters",
        user_id=user.sub,
        metadata={"bookId": book_id, "chapterCount": body.chapter_count, "language": body.language},
    )
    if body.sync:
        try:
            await _generate_chapters_now(job["id"], book_id, book, body.chapter_count, body.language)
        except Exception as exc:
            await jobs_repo.fail_job(job["id"], str(exc))
            raise
        return JobAccepted(job_id=job["id"])

    task_generate_chapters.delay(job["id"], book_id, book, body.chapter_count, body.language)
    return JobAccepted(job_id=job["id"])


# ── 3.2 POST /books/{book_id}/chapters ───────────────────────────────────────

@router.post(
    "/{book_id}/chapters",
    response_model=dict,
    status_code=status.HTTP_201_CREATED,
    summary="3.2 Añadir capítulo manualmente",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        422: {"description": "VALIDATION_ERROR"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def add_chapter(
    book_id: str,
    body:    ChapterCreate,
    user:    CurrentUser = Depends(get_current_user),
):
    """
    Añade un capítulo al final de la lista con el siguiente orderIndex disponible.
    El orden puede modificarse posteriormente con el endpoint reorder.
    """
    await _get_book_for_user(book_id, user.sub)
    existing = await books_repo.get_chapters(book_id)
    order_index = len(existing)
    chapter = await books_repo.create_chapter(book_id, {
        "title":            body.title,
        "description":      body.description or "",
        "orderIndex":       order_index,
        "status":           "pending",
        "wordCount":        0,
        "contentAvailable": False,
    })
    return chapter


# ── 3.3 PUT /books/{book_id}/chapters/reorder ─────────────────────────────────

@router.put(
    "/{book_id}/chapters/reorder",
    response_model=dict,
    status_code=status.HTTP_200_OK,
    summary="3.4 Reordenar capítulos (bulk)",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        400: {"description": "INCOMPLETE_CHAPTER_LIST"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def reorder_chapters(
    book_id: str,
    body:    ChapterReorder,
    user:    CurrentUser = Depends(get_current_user),
):
    """
    Acepta un array completo y ordenado de chapter IDs.
    Valida que todos los IDs pertenezcan al book y que no falte ninguno,
    luego persiste el nuevo orden atómicamente.
    """
    await _get_book_for_user(book_id, user.sub)
    existing = await books_repo.get_chapters(book_id)
    existing_ids = {c["id"] for c in existing}
    incoming_ids = set(body.chapter_ids)

    if existing_ids != incoming_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code":    "INCOMPLETE_CHAPTER_LIST",
                "message": "chapterIds debe incluir exactamente todos los IDs de capítulos existentes.",
            },
        )

    for index, chapter_id in enumerate(body.chapter_ids):
        await books_repo.update_chapter(book_id, chapter_id, {"orderIndex": index})

    chapters = await books_repo.get_chapters(book_id)
    return {"message": "Chapters reordered successfully", "chapters": chapters}


# ── 3.4 PUT /books/{book_id}/chapters/{chapter_id} ───────────────────────────

@router.put(
    "/{book_id}/chapters/{chapter_id}",
    response_model=dict,
    status_code=status.HTTP_200_OK,
    summary="3.3 Actualizar título o descripción de un capítulo",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        422: {"description": "VALIDATION_ERROR"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def update_chapter(
    book_id:    str,
    chapter_id: str,
    body:       ChapterUpdate,
    user:       CurrentUser = Depends(get_current_user),
):
    """
    Actualización parcial del capítulo. Cambiar description NO regenera
    el contenido automáticamente.
    """
    await _get_chapter_for_user(book_id, chapter_id, user.sub)
    update_data = body.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update."
        )
    return await books_repo.update_chapter(book_id, chapter_id, update_data)


# ── 3.5 DELETE /books/{book_id}/chapters/{chapter_id} ────────────────────────

@router.delete(
    "/{book_id}/chapters/{chapter_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="3.5 Eliminar capítulo",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def delete_chapter(
    book_id:    str,
    chapter_id: str,
    user:       CurrentUser = Depends(get_current_user),
):
    """
    Elimina el capítulo y su contenido generado.
    El estado del book padre NO se degrada automáticamente.
    """
    await _get_chapter_for_user(book_id, chapter_id, user.sub)
    await books_repo.delete_chapter(book_id, chapter_id)


# =============================================================================
# SECCIÓN 4 — CONTENT GENERATION
# =============================================================================

# ── 4.1 POST /books/{book_id}/content/generate ───────────────────────────────

@router.post(
    "/{book_id}/content/generate",
    response_model=JobAccepted,
    status_code=status.HTTP_202_ACCEPTED,
    summary="4.1 Generar contenido de todos los capítulos (async)",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        409: {"description": "NO_CHAPTERS"},
        503: {"description": "LLM_UNAVAILABLE"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def generate_all_content(
    book_id: str,
    body:    GenerateContentRequest,
    user:    CurrentUser = Depends(get_current_user),
):
    """
    Itera por todos los capítulos en orden, enviando título y descripción
    al LLM para generar el cuerpo completo. Job típico: 30-120 segundos
    para un book de 5 capítulos.
    """
    book = await _get_book_for_user(book_id, user.sub)
    chapters = await books_repo.get_chapters(book_id)
    if not chapters:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "NO_CHAPTERS", "message": "No chapters found. Add chapters before generating content."}
        )

    job = await jobs_repo.create_job(
        job_type="generate_all_content",
        user_id=user.sub,
        metadata={"bookId": book_id, "contentType": _enum_value(body.content_type), "style": _enum_value(body.style), "language": body.language},
    )
    if body.sync:
        try:
            await _generate_all_content_now(job["id"], book_id, book, chapters, body.content_type, body.style, body.language)
        except Exception as exc:
            await jobs_repo.fail_job(job["id"], str(exc))
            raise
        return JobAccepted(job_id=job["id"])

    try:
        task_generate_all_content.delay(job["id"], book_id, book, chapters, body.content_type, body.style, body.language)
    except Exception:
        # Redis/Celery no disponible — ejecutar síncronamente
        try:
            await _generate_all_content_now(job["id"], book_id, book, chapters, body.content_type, body.style, body.language)
        except Exception as exc:
            await jobs_repo.fail_job(job["id"], str(exc))
            raise
    return JobAccepted(job_id=job["id"])


# ── 4.2 POST /books/{book_id}/chapters/{chapter_id}/content/generate ──────────

@router.post(
    "/{book_id}/chapters/{chapter_id}/content/generate",
    response_model=dict,
    status_code=status.HTTP_200_OK,
    summary="4.2 Regenerar contenido de un capítulo (async)",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        503: {"description": "LLM_UNAVAILABLE"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def generate_single_chapter_content(
    book_id:    str,
    chapter_id: str,
    body:       GenerateContentRequest,
    user:       CurrentUser = Depends(get_current_user),
):
    """
    Genera o regenera el contenido LLM para un capítulo específico,
    sobreescribiendo cualquier contenido previo.
    """
    book    = await _get_book_for_user(book_id, user.sub)
    chapter = await _get_chapter_for_user(book_id, chapter_id, user.sub)

    job = await jobs_repo.create_job(
        job_type="generate_single_chapter",
        user_id=user.sub,
        metadata={"bookId": book_id, "chapterId": chapter_id, "language": body.language},
    )
    if body.sync:
        try:
            await _generate_single_chapter_now(job["id"], book_id, book, chapter, body.content_type, body.style, body.language)
        except Exception as exc:
            await jobs_repo.fail_job(job["id"], str(exc))
            raise
        return {"jobId": job["id"], "status": "pending"}

    try:
        task_generate_single_chapter.delay(
            job["id"], book_id, book, chapter, body.content_type, body.style, body.language
        )
    except Exception:
        # Redis/Celery no disponible — ejecutar síncronamente
        try:
            await _generate_single_chapter_now(job["id"], book_id, book, chapter, body.content_type, body.style, body.language)
        except Exception as exc:
            await jobs_repo.fail_job(job["id"], str(exc))
            raise
    return {"jobId": job["id"], "status": "pending"}


# ── 4.3 POST /books/{book_id}/chapters/{chapter_id}/content/refine ────────────

@router.post(
    "/{book_id}/chapters/{chapter_id}/content/refine",
    response_model=dict,
    status_code=status.HTTP_200_OK,
    summary="4.3 Refinar contenido con instrucción LLM (no guarda)",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        400: {"description": "NO_CONTENT"},
        503: {"description": "LLM_UNAVAILABLE"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def refine_chapter_content(
    book_id:    str,
    chapter_id: str,
    body:       RefineContentRequest,
    user:       CurrentUser = Depends(get_current_user),
):
    """
    Aplica una instrucción de refinamiento al contenido existente del capítulo.
    Devuelve el texto refinado para preview en el cliente SIN guardarlo.
    El usuario debe aceptar explícitamente para persistir el cambio.
    """
    chapter = await _get_chapter_for_user(book_id, chapter_id, user.sub)
    existing = chapter.get("content")
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "NO_CONTENT", "message": "Chapter has no existing content to refine. Generate content first."}
        )

    refined = await book_ai_service.refine_content(existing_content=existing, instruction=body.instruction, language=body.language)
    return {"refinedContent": refined}


# ── 4.4 PUT /books/{book_id}/chapters/{chapter_id}/content ───────────────────

@router.put(
    "/{book_id}/chapters/{chapter_id}/content",
    response_model=dict,
    status_code=status.HTTP_200_OK,
    summary="4.4 Guardar contenido del editor WYSIWYG",
    responses={
        401: {"description": "UNAUTHORIZED"},
        403: {"description": "FORBIDDEN"},
        404: {"description": "NOT_FOUND"},
        422: {"description": "VALIDATION_ERROR"},
        500: {"description": "INTERNAL_SERVER_ERROR"},
    },
)
async def save_chapter_content(
    book_id:    str,
    chapter_id: str,
    body:       ChapterContentSave,
    user:       CurrentUser = Depends(get_current_user),
):
    """
    Persiste el contenido HTML/Markdown editado por el usuario en el editor
    WYSIWYG. Llamado en 'Guardar borrador' o auto-save. Recalcula wordCount.
    """
    await _get_chapter_for_user(book_id, chapter_id, user.sub)

    import re
    text = re.sub(r"<[^>]+>", " ", body.content)
    word_count = len(text.split())

    updated = await books_repo.update_chapter(book_id, chapter_id, {
        "content":          body.content,
        "format":           body.format,
        "wordCount":        word_count,
        "status":           "edited",
        "contentAvailable": True,
    })
    return updated
