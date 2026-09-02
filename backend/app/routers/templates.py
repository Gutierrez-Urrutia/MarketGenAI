"""Templates router — manage reusable prompt/content templates."""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from docx import Document

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover - dependency is declared in requirements.txt
    PdfReader = None

from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.template import (
    TemplateCreate, TemplateUpdate, TemplateOut, TemplateListResponse,
    ApplyTemplateRequest,
)
from app.services.firestore_service import templates_repo

router = APIRouter(prefix="/templates", tags=["Templates"])

SUPPORTED_UPLOAD_EXTENSIONS = {".txt", ".md", ".html", ".htm", ".docx", ".pdf"}


def _assert_owner(template: dict, user: CurrentUser) -> None:
    if template.get("userId") != user.sub and not template.get("isPublic"):
        raise HTTPException(status_code=403, detail="Access denied.")


async def _get_template_for_user(template_id: str, user: CurrentUser) -> dict:
    template = await templates_repo.get(template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found.")
    _assert_owner(template, user)
    return template


def _decode_text_file(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def _extract_docx_text(content: bytes) -> str:
    document = Document(BytesIO(content))
    parts: list[str] = []
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if text:
            parts.append(text)
    for table in document.tables:
        for row in table.rows:
            row_text = "\t".join(cell.text.strip() for cell in row.cells if cell.text.strip())
            if row_text:
                parts.append(row_text)
    return "\n\n".join(parts)


def _extract_pdf_text(content: bytes) -> str:
    if PdfReader is None:
        raise HTTPException(status_code=500, detail="PDF extraction is not available. Install pypdf to enable PDF uploads.")
    reader = PdfReader(BytesIO(content))
    pages = [(page.extract_text() or "").strip() for page in reader.pages]
    return "\n\n".join(page for page in pages if page)


def _extract_template_content(filename: str, content: bytes) -> str:
    extension = Path(filename or "").suffix.lower()
    if extension in {".txt", ".md", ".html", ".htm"}:
        return _decode_text_file(content)
    if extension == ".docx":
        return _extract_docx_text(content)
    if extension == ".pdf":
        return _extract_pdf_text(content)
    supported = ", ".join(sorted(SUPPORTED_UPLOAD_EXTENSIONS))
    raise HTTPException(status_code=400, detail=f"Unsupported template file type. Supported formats: {supported}.")


def _template_name_from_filename(filename: str) -> str:
    stem = Path(filename or "template").stem.strip()
    return stem or "template"


@router.post("/extract")
async def extract_template_file(
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded template file is empty.")
    extracted = _extract_template_content(file.filename or "", content).strip()
    if not extracted:
        raise HTTPException(status_code=400, detail="Could not extract text from this template file.")
    return {
        "name": _template_name_from_filename(file.filename or "template"),
        "content": extracted,
    }


# ── List ──────────────────────────────────────────────────────────────────────
@router.get("", response_model=TemplateListResponse)
async def list_templates(
    template_type: Optional[str] = Query(None, alias="type"),
    search:        Optional[str] = Query(None),
    include_public: bool         = Query(True),
    limit:         int           = Query(20, ge=1, le=100),
    offset:        int           = Query(0, ge=0),
    user:          CurrentUser   = Depends(get_current_user),
):
    filters = [("userId", "==", user.sub)]
    if template_type:
        filters.append(("type", "==", template_type))

    user_templates = await templates_repo.list(
        filters=filters, order_by="usageCount",
        order_direction="DESCENDING", limit=limit, offset=offset,
    )

    public_templates = []
    if include_public:
        pub_filters = [("isPublic", "==", True)]
        if template_type:
            pub_filters.append(("type", "==", template_type))
        public_templates = await templates_repo.list(
            filters=pub_filters, order_by="usageCount",
            order_direction="DESCENDING", limit=10,
        )
        # Deduplicate: remove public templates user already owns
        user_ids = {t["id"] for t in user_templates}
        public_templates = [t for t in public_templates if t["id"] not in user_ids]

    all_templates = user_templates + public_templates

    if search:
        s = search.lower()
        all_templates = [t for t in all_templates if s in t.get("name", "").lower() or s in (t.get("description") or "").lower()]

    total = await templates_repo.count(filters=[("userId", "==", user.sub)])
    return TemplateListResponse(items=all_templates, total=total)


# ── Create ────────────────────────────────────────────────────────────────────
@router.post("", response_model=TemplateOut, status_code=201)
async def create_template(
    body: TemplateCreate,
    user: CurrentUser = Depends(get_current_user),
):
    data = body.model_dump()
    data["userId"] = user.sub
    data["usageCount"] = 0
    return await templates_repo.create(data)


# ── Get one ───────────────────────────────────────────────────────────────────
@router.get("/{template_id}", response_model=TemplateOut)
async def get_template(
    template_id: str,
    user:        CurrentUser = Depends(get_current_user),
):
    return await _get_template_for_user(template_id, user)


# ── Update ────────────────────────────────────────────────────────────────────
@router.put("/{template_id}", response_model=TemplateOut)
async def update_template(
    template_id: str,
    body:        TemplateUpdate,
    user:        CurrentUser = Depends(get_current_user),
):
    template = await templates_repo.get(template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found.")
    if template.get("userId") != user.sub:
        raise HTTPException(status_code=403, detail="Only the owner can edit this template.")
    return await templates_repo.update(template_id, body.model_dump(exclude_none=True))


# ── Delete ────────────────────────────────────────────────────────────────────
@router.delete("/{template_id}", status_code=204)
async def delete_template(
    template_id: str,
    user:        CurrentUser = Depends(get_current_user),
):
    template = await templates_repo.get(template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found.")
    if template.get("userId") != user.sub:
        raise HTTPException(status_code=403, detail="Only the owner can delete this template.")
    await templates_repo.delete(template_id)


# ── Apply template (fill in variables) ───────────────────────────────────────
@router.post("/{template_id}/apply")
async def apply_template(
    template_id: str,
    body:        ApplyTemplateRequest,
    user:        CurrentUser = Depends(get_current_user),
):
    """
    Substitute {variable} placeholders in the template content with provided values.
    Returns the rendered content string.
    """
    template = await _get_template_for_user(template_id, user)
    content = template["content"]
    for key, value in body.variables.items():
        content = content.replace(f"{{{key}}}", str(value))
    # Increment usage counter
    await templates_repo.update(template_id, {"usageCount": template.get("usageCount", 0) + 1})
    return {"rendered": content, "templateId": template_id}
