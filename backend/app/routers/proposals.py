import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional
from xml.sax.saxutils import escape

from bs4 import BeautifulSoup
from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import (
    HRFlowable,
    ListFlowable,
    ListItem,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.core.rate_limit import limiter
from app.config import settings
from app.dependencies.auth import CurrentUser, get_current_user
from app.schemas.proposal import (
    GenerateProposalRequest,
    ProposalCreate,
    ProposalOut,
    ProposalUpdate,
    ProposalVersionCreate,
    SendToCrmRequest,
)
from app.services.firestore_service import opportunities_repo, proposals_repo
from app.services import deepseek_service
from app.services.rag_netprovider import get_rag_context
from app.rendering.brand_styles import (
    BRAND_BORDER,
    BRAND_DEEP_NAVY as BRAND_NAVY_DEEP,
    BRAND_MUTED,
    BRAND_NAVY,
    BRAND_PRIMARY_INDIGO as BRAND_INDIGO,
    BRAND_SOFT_INDIGO_SURFACE as BRAND_INDIGO_SOFT,
    BRAND_SURFACE,
    BRAND_TEXT,
)

router = APIRouter(prefix="/proposals", tags=["Proposals"])

# Brand palette — mirrors the --proposal-* tokens in frontend/src/index.css
# so exported PDFs/DOCX match the on-screen proposal preview.
PROPOSAL_STATUS_SCORES = {
    "Generada": 16,
    "Entregada": 32,
    "En Negociación": 48,
    "Cerrada": 64,
    "En Contrato": 80,
    "Perdida": 0,
}


# ── Helpers internos ──────────────────────────────────────────────────────────

def _output_dir() -> Path:
    if os.getenv("VERCEL"):
        output_dir = Path("/tmp/marketgen_generated_files")
    else:
        output_dir = Path("generated_files")
    output_dir.mkdir(exist_ok=True)
    return output_dir


def _assert_owner(proposal: dict, user_id: str):
    """Lanza 403 si la propuesta no pertenece al usuario autenticado."""
    if proposal.get("userId") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied."
        )


async def _get_proposal_for_user(proposal_id: str, user_id: str) -> dict:
    """Obtiene una propuesta de Firestore y verifica ownership. Lanza 404 o 403 según corresponda."""
    try:
        proposal = await proposals_repo.get_or_404(proposal_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Proposal '{proposal_id}' not found."
        )
    _assert_owner(proposal, user_id)
    return proposal


def _format_usd(value) -> str:
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return "Not calculated"
    return f"${amount:,.0f} USD"


def _proposal_cover_fields(proposal: dict) -> dict:
    """Pulls the cover-page metadata (client, total, dates...) used by both
    the PDF and DOCX exports, mirroring normalizeProposalDocument() on the frontend."""
    structured = proposal.get("structured_content") or proposal.get("structuredContent") or {}

    total_amount = proposal.get("totalAmount")
    if total_amount is None:
        total_amount = proposal.get("total_amount")
    if total_amount is None:
        total_amount = structured.get("totalAmount")

    created_at = proposal.get("createdAt") or proposal.get("created_at")
    issued_on = None
    if isinstance(created_at, datetime):
        issued_on = created_at
    elif isinstance(created_at, str):
        try:
            issued_on = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except ValueError:
            issued_on = None
    issued_on = issued_on or datetime.now(timezone.utc)
    valid_until = issued_on + timedelta(days=30)

    return {
        "client": (
            proposal.get("clientName")
            or proposal.get("customerName")
            or proposal.get("customer_name")
            or structured.get("client")
            or ""
        ),
        "contact": structured.get("contact") or proposal.get("contact") or "",
        "industry": structured.get("industry") or proposal.get("industry") or "",
        "service_line": structured.get("serviceLine") or structured.get("service_line") or proposal.get("template") or "",
        "total_amount_display": _format_usd(total_amount),
        "issued_on": issued_on.strftime("%B %d, %Y"),
        "valid_until": valid_until.strftime("%B %d, %Y"),
        "prepared_by": proposal.get("issuedBy") or "—",
    }


def _split_proposal_content(html_content: str):
    """Splits the AI-generated HTML fragment into (content_title, subtitle, body_tags),
    so the leading <h1>/<p> can be promoted into the document cover instead of being
    repeated inside the body."""
    soup = BeautifulSoup(html_content or "", "html.parser")
    body_tags = [
        tag for tag in soup.find_all(["h1", "h2", "p", "ul", "ol", "table"], recursive=False)
    ]

    content_title = None
    if body_tags and body_tags[0].name == "h1":
        content_title = body_tags[0].get_text(" ", strip=True)
        body_tags = body_tags[1:]

    subtitle = None
    if body_tags and body_tags[0].name == "p":
        subtitle = body_tags[0].get_text(" ", strip=True)
        body_tags = body_tags[1:]

    return content_title, subtitle, body_tags


def _table_rows_from_html(table_tag):
    header_cells = [th.get_text(" ", strip=True) for th in table_tag.find_all("th")]
    body_rows = []
    for tr in table_tag.find_all("tr"):
        cells = tr.find_all("td")
        if cells:
            body_rows.append([td.get_text(" ", strip=True) for td in cells])
    col_count = len(header_cells) if header_cells else (len(body_rows[0]) if body_rows else 0)
    return header_cells, body_rows, col_count


def _pdf_page_decoration(canvas_obj, _doc_template):
    canvas_obj.saveState()
    canvas_obj.setStrokeColor(colors.HexColor(BRAND_BORDER))
    canvas_obj.setLineWidth(0.5)
    canvas_obj.line(54, 40, LETTER[0] - 54, 40)
    canvas_obj.setFont("Helvetica", 8)
    canvas_obj.setFillColor(colors.HexColor(BRAND_MUTED))
    canvas_obj.drawString(54, 28, "NoonDalton AI Marketing Suite")
    canvas_obj.drawRightString(LETTER[0] - 54, 28, f"Page {canvas_obj.getPageNumber()}")
    canvas_obj.restoreState()


def _pdf_table(table_tag, styles) -> list:
    header_cells, body_rows, col_count = _table_rows_from_html(table_tag)
    if col_count == 0:
        return []

    data = []
    if header_cells:
        data.append([Paragraph(escape(text), styles["th"]) for text in header_cells])
    for row in body_rows:
        padded = (row + [""] * col_count)[:col_count]
        data.append([Paragraph(escape(text), styles["td"]) for text in padded])

    usable_width = LETTER[0] - 108
    weights = [0.18, 0.36, 0.1, 0.16, 0.2] if col_count == 5 else [1 / col_count] * col_count
    col_widths = [usable_width * weight for weight in weights]

    table = Table(data, colWidths=col_widths, repeatRows=1 if header_cells else 0)
    style_commands = [
        ("GRID", (0, 0), (-1, -1), 0.6, colors.HexColor(BRAND_BORDER)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]
    start_row = 0
    if header_cells:
        style_commands.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(BRAND_INDIGO_SOFT)))
        style_commands.append(("LINEBELOW", (0, 0), (-1, 0), 1.4, colors.HexColor(BRAND_INDIGO)))
        start_row = 1
    for row_index in range(start_row, len(data)):
        if (row_index - start_row) % 2 == 1:
            style_commands.append(("BACKGROUND", (0, row_index), (-1, row_index), colors.HexColor(BRAND_SURFACE)))
    table.setStyle(TableStyle(style_commands))
    return [table]


def _pdf_total_highlight(total_display: str, styles) -> Table:
    usable_width = LETTER[0] - 108
    table = Table(
        [[
            Paragraph("Total Implementation Cost", styles["total_label"]),
            Paragraph(escape(total_display), styles["total_value"]),
        ]],
        colWidths=[usable_width * 0.6, usable_width * 0.4],
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(BRAND_INDIGO_SOFT)),
        ("LINEBEFORE", (0, 0), (0, -1), 3, colors.HexColor(BRAND_INDIGO)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    return table


def _pdf_body_flowables(body_tags, styles, total_display: str) -> list:
    story = []
    pending_bullets: list[str] | None = None

    def flush_bullets():
        nonlocal pending_bullets
        if pending_bullets:
            story.append(ListFlowable(
                [ListItem(Paragraph(escape(item), styles["body"]), leftIndent=6) for item in pending_bullets],
                bulletType="bullet",
                start="circle",
                leftIndent=16,
                bulletFontSize=7,
                bulletColor=colors.HexColor(BRAND_INDIGO),
            ))
            story.append(Spacer(1, 6))
            pending_bullets = None

    for tag in body_tags:
        name = tag.name
        if name == "h2":
            flush_bullets()
            story.append(Paragraph(escape(tag.get_text(" ", strip=True)), styles["h2"]))
            story.append(HRFlowable(width="100%", thickness=1.4, color=colors.HexColor(BRAND_INDIGO), spaceAfter=10, hAlign="LEFT"))
        elif name == "p":
            flush_bullets()
            text = tag.get_text(" ", strip=True)
            if text:
                story.append(Paragraph(escape(text), styles["body"]))
        elif name == "ul":
            flush_bullets()
            pending_bullets = [li.get_text(" ", strip=True) for li in tag.find_all("li") if li.get_text(strip=True)]
        elif name == "ol":
            flush_bullets()
            items = [li.get_text(" ", strip=True) for li in tag.find_all("li") if li.get_text(strip=True)]
            if items:
                story.append(ListFlowable(
                    [ListItem(Paragraph(escape(item), styles["body"])) for item in items],
                    bulletType="1",
                    leftIndent=16,
                    bulletFontSize=9,
                    bulletColor=colors.HexColor(BRAND_NAVY),
                ))
                story.append(Spacer(1, 6))
        elif name == "table":
            flush_bullets()
            table_flowables = _pdf_table(tag, styles)
            if table_flowables:
                story.extend(table_flowables)
                story.append(Spacer(1, 10))
                story.append(_pdf_total_highlight(total_display, styles))
                story.append(Spacer(1, 10))
    flush_bullets()
    return story


def _build_proposal_pdf(file_path: Path, record_title: str, html_content: str, cover: dict) -> None:
    navy = colors.HexColor(BRAND_NAVY)
    navy_deep = colors.HexColor(BRAND_NAVY_DEEP)
    indigo = colors.HexColor(BRAND_INDIGO)
    muted = colors.HexColor(BRAND_MUTED)
    border = colors.HexColor(BRAND_BORDER)
    text_color = colors.HexColor(BRAND_TEXT)

    base = getSampleStyleSheet()
    styles = {
        "title": ParagraphStyle("ProposalTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=23, leading=27, textColor=navy_deep, alignment=0, spaceAfter=4),
        "subtitle": ParagraphStyle("ProposalSubtitle", parent=base["Normal"], fontSize=11, leading=15, textColor=muted, spaceAfter=12),
        "meta": ParagraphStyle("ProposalMeta", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=9, leading=13, textColor=navy, spaceAfter=2),
        "h2": ParagraphStyle("ProposalH2", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=13.5, leading=16, textColor=navy, spaceBefore=16, spaceAfter=4),
        "body": ParagraphStyle("ProposalBody", parent=base["BodyText"], fontSize=10, leading=15, textColor=text_color, spaceAfter=8),
        "th": ParagraphStyle("ProposalTh", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=9, textColor=navy_deep),
        "td": ParagraphStyle("ProposalTd", parent=base["Normal"], fontSize=9, textColor=text_color),
        "info_label": ParagraphStyle("ProposalInfoLabel", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=7.5, textColor=muted, spaceAfter=2),
        "info_value": ParagraphStyle("ProposalInfoValue", parent=base["Normal"], fontSize=10, textColor=text_color),
        "total_label": ParagraphStyle("ProposalTotalLabel", parent=base["Normal"], fontSize=10.5, textColor=navy_deep),
        "total_value": ParagraphStyle("ProposalTotalValue", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=13, textColor=navy_deep, alignment=2),
    }

    content_title, subtitle, body_tags = _split_proposal_content(html_content)
    usable_width = LETTER[0] - 108

    story = [
        HRFlowable(width="100%", thickness=3.5, color=indigo, spaceAfter=16),
        Paragraph(escape(content_title or record_title or "Proposal"), styles["title"]),
    ]
    if subtitle:
        story.append(Paragraph(escape(subtitle), styles["subtitle"]))
    meta_bits = [bit for bit in [cover["industry"], cover["contact"], cover["service_line"]] if bit]
    if meta_bits:
        story.append(Paragraph(escape("   •   ".join(meta_bits)), styles["meta"]))
    story.append(Spacer(1, 12))

    info_pairs = [
        ("TOTAL", cover["total_amount_display"]),
        ("ISSUED ON", cover["issued_on"]),
        ("VALID UNTIL", cover["valid_until"]),
        ("PREPARED BY", cover["prepared_by"]),
    ]
    info_table = Table(
        [[[Paragraph(label, styles["info_label"]), Paragraph(escape(str(value) or "—"), styles["info_value"])] for label, value in info_pairs]],
        colWidths=[usable_width / 4] * 4,
    )
    info_table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, border),
        ("INNERGRID", (0, 0), (-1, -1), 0.6, border),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 10))
    story.append(HRFlowable(width="100%", thickness=0.75, color=border, spaceAfter=4))

    story.extend(_pdf_body_flowables(body_tags, styles, cover["total_amount_display"]))

    pdf = SimpleDocTemplate(
        str(file_path),
        pagesize=LETTER,
        leftMargin=54,
        rightMargin=54,
        topMargin=46,
        bottomMargin=56,
    )
    pdf.build(story, onFirstPage=_pdf_page_decoration, onLaterPages=_pdf_page_decoration)


def _set_run_color(run, hex_color: str) -> None:
    run.font.color.rgb = RGBColor.from_string(hex_color.lstrip("#"))


def _shade_cell(cell, hex_color: str) -> None:
    shading = OxmlElement("w:shd")
    shading.set(qn("w:val"), "clear")
    shading.set(qn("w:color"), "auto")
    shading.set(qn("w:fill"), hex_color.lstrip("#"))
    cell._tc.get_or_add_tcPr().append(shading)


def _set_cell_borders(cell, hex_color: str, sz: int = 6) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), str(sz))
        element.set(qn("w:color"), hex_color.lstrip("#"))
        borders.append(element)
    tc_pr.append(borders)


def _add_heading_rule(paragraph, hex_color: str) -> None:
    """Adds a colored bottom border under a heading paragraph, mirroring the
    h2 underline used in the on-screen proposal preview."""
    p_pr = paragraph._p.get_or_add_pPr()
    p_borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "16")
    bottom.set(qn("w:space"), "4")
    bottom.set(qn("w:color"), hex_color.lstrip("#"))
    p_borders.append(bottom)
    p_pr.append(p_borders)


def _add_docx_pricing_table(doc: Document, table_tag) -> None:
    header_cells, body_rows, col_count = _table_rows_from_html(table_tag)
    if col_count == 0:
        return

    table = doc.add_table(rows=0, cols=col_count)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    if header_cells:
        header_row = table.add_row()
        for col, text in enumerate(header_cells):
            cell = header_row.cells[col]
            cell.text = text
            _shade_cell(cell, BRAND_INDIGO_SOFT)
            for run in cell.paragraphs[0].runs:
                run.bold = True
                run.font.size = Pt(9.5)
                _set_run_color(run, BRAND_NAVY_DEEP)

    for row_index, row_values in enumerate(body_rows):
        row = table.add_row()
        padded = (row_values + [""] * col_count)[:col_count]
        for col, text in enumerate(padded):
            cell = row.cells[col]
            cell.text = text
            for run in cell.paragraphs[0].runs:
                run.font.size = Pt(9.5)
            if row_index % 2 == 1:
                _shade_cell(cell, BRAND_SURFACE)

    for row in table.rows:
        for cell in row.cells:
            _set_cell_borders(cell, BRAND_BORDER)

    doc.add_paragraph()


def _add_docx_total_highlight(doc: Document, total_display: str) -> None:
    table = doc.add_table(rows=1, cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    label_cell, value_cell = table.rows[0].cells
    label_cell.text = "Total Implementation Cost"
    value_cell.text = total_display

    for cell in (label_cell, value_cell):
        _shade_cell(cell, BRAND_INDIGO_SOFT)
    label_cell._tc.get_or_add_tcPr().append(_left_border_element(BRAND_INDIGO))

    for run in label_cell.paragraphs[0].runs:
        run.font.size = Pt(10.5)
        _set_run_color(run, BRAND_NAVY_DEEP)

    value_cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for run in value_cell.paragraphs[0].runs:
        run.bold = True
        run.font.size = Pt(13)
        _set_run_color(run, BRAND_NAVY_DEEP)

    doc.add_paragraph()


def _left_border_element(hex_color: str):
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), "24")
    left.set(qn("w:color"), hex_color.lstrip("#"))
    borders = OxmlElement("w:tcBorders")
    borders.append(left)
    return borders


def _build_proposal_docx(file_path: Path, record_title: str, html_content: str, cover: dict) -> None:
    content_title, subtitle, body_tags = _split_proposal_content(html_content)

    doc = Document()
    base_style = doc.styles["Normal"]
    base_style.font.name = "Calibri"
    base_style.font.size = Pt(10.5)
    base_style.font.color.rgb = RGBColor.from_string(BRAND_TEXT.lstrip("#"))

    title_paragraph = doc.add_heading(content_title or record_title or "Proposal", level=0)
    for run in title_paragraph.runs:
        run.font.name = "Calibri"
        _set_run_color(run, BRAND_NAVY_DEEP)

    if subtitle:
        subtitle_paragraph = doc.add_paragraph(subtitle)
        for run in subtitle_paragraph.runs:
            run.font.size = Pt(10.5)
            _set_run_color(run, BRAND_MUTED)

    meta_bits = [bit for bit in [cover["industry"], cover["contact"], cover["service_line"]] if bit]
    if meta_bits:
        meta_paragraph = doc.add_paragraph("   •   ".join(meta_bits))
        for run in meta_paragraph.runs:
            run.bold = True
            run.font.size = Pt(9)
            _set_run_color(run, BRAND_NAVY)

    doc.add_paragraph()

    info_table = doc.add_table(rows=2, cols=4)
    info_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    info_pairs = [
        ("TOTAL", cover["total_amount_display"]),
        ("ISSUED ON", cover["issued_on"]),
        ("VALID UNTIL", cover["valid_until"]),
        ("PREPARED BY", cover["prepared_by"]),
    ]
    for col, (label, value) in enumerate(info_pairs):
        label_cell = info_table.cell(0, col)
        label_cell.text = label
        for run in label_cell.paragraphs[0].runs:
            run.bold = True
            run.font.size = Pt(7.5)
            _set_run_color(run, BRAND_MUTED)

        value_cell = info_table.cell(1, col)
        value_cell.text = str(value) or "—"
        for run in value_cell.paragraphs[0].runs:
            run.font.size = Pt(10)

        _set_cell_borders(label_cell, BRAND_BORDER)
        _set_cell_borders(value_cell, BRAND_BORDER)

    doc.add_paragraph()

    for tag in body_tags:
        name = tag.name
        if name == "h2":
            heading = doc.add_heading(tag.get_text(" ", strip=True), level=1)
            for run in heading.runs:
                run.font.name = "Calibri"
                run.font.size = Pt(13)
                _set_run_color(run, BRAND_NAVY)
            _add_heading_rule(heading, BRAND_INDIGO)
        elif name == "p":
            text = tag.get_text(" ", strip=True)
            if text:
                doc.add_paragraph(text)
        elif name == "ul":
            for li in tag.find_all("li"):
                text = li.get_text(" ", strip=True)
                if text:
                    doc.add_paragraph(text, style="List Bullet")
        elif name == "ol":
            for li in tag.find_all("li"):
                text = li.get_text(" ", strip=True)
                if text:
                    doc.add_paragraph(text, style="List Number")
        elif name == "table":
            _add_docx_pricing_table(doc, tag)
            _add_docx_total_highlight(doc, cover["total_amount_display"])

    doc.save(file_path)


def _format_proposal_line_items(line_items: list[dict] | None, total_amount: float | None) -> str:
    if not line_items:
        return (
            "No pricing items were provided. The cost table must contain only one row "
            'whose service and price both say "A definir". Do not invent services or prices.'
        )

    rows = []
    for index, item in enumerate(line_items, start=1):
        name = item.get("name") or item.get("service") or "A definir"
        qty = item.get("qty") if item.get("qty") is not None else item.get("quantity")
        unit_price = item.get("unitPrice") if item.get("unitPrice") is not None else item.get("unit_price")
        rows.append(
            f"{index}. Service: {name} | "
            f"Description: {item.get('description') or 'N/A'} | "
            f"Quantity: {qty if qty is not None else 'A definir'} | "
            f"Unit price: {unit_price if unit_price is not None else 'A definir'}"
        )

    total = total_amount if total_amount is not None else "A definir"
    return "\n".join([
        *rows,
        f"Provided total: {total}",
        "Build the HTML cost table EXACTLY from the items and amounts above. "
        "Do not invent, rename, remove, merge, or add services or prices.",
    ])


async def _generate_proposal_content(
    title: str,
    client_name: str,
    description: str,
    *,
    detailed_description: str | None = None,
    team_sizing: str | None = None,
    line_items: list[dict] | None = None,
    total_amount: float | None = None,
    length: str = "standard",
    language: str = "es",
    custom_prompt: str | None = None,
) -> dict:
    """Call the LLM with the real proposal context and persist its response."""
    length_instructions = {
        "brief": """
Generate a concise professional proposal of approximately 400-600 words, designed to produce about 1 page of substantive content.

Depth requirement:
- Keep every required section present and complete, but synthesize each section tightly.
- Executive Summary must be concise and client-specific, explaining the opportunity and proposed value in a few strong paragraphs.
- Problems Identified must summarize the most important client problems without over-expanding.
- Proposed AI Solution must clearly explain the recommended approach and how it addresses the identified problems.
- Implementation Costs must use ONLY the provided pricing data. Do not invent, rename, remove, merge, or add services or prices.
- Expected ROI must briefly describe practical business impact areas and measurable outcomes where appropriate. Do not invent unsupported financial figures.
- Next Steps must be short, practical, and action-oriented.

Anti-filler requirement:
The proposal must gain clarity through specificity, client-relevant analysis, concrete examples, and professional detail. Never increase length through repetition, generic filler, empty phrases, vague claims, or padded wording. Write like a senior commercial consultant preparing a serious client-facing proposal.

Respect the 400-600 word target as closely as possible while preserving quality, the required HTML structure, the exact section headings, the requested language, the custom prompt, and all pricing rules.
""".strip(),
        "standard": """
Generate a complete standard professional proposal of approximately 900-1300 words, designed to produce about 3 pages of substantive content.

Depth requirement:
- Develop every required section with 1-2 substantial paragraphs where appropriate.
- Executive Summary must explain the client's business context, the opportunity, and the strategic value of the proposed engagement.
- Problems Identified must include clear points with operational, process, quality, financial, or growth implications based on the client description, detailed process, industry, and team sizing provided.
- Proposed AI Solution must explain the recommended approach, operating model, workflow, technologies, and how the solution addresses each identified problem.
- Implementation Costs must use ONLY the provided pricing data. Do not invent, rename, remove, merge, or add services or prices.
- Expected ROI must include concrete business impact areas, operational metrics, efficiency gains, quality improvements, risk reduction, and measurable outcomes where appropriate. Do not invent unsupported financial figures.
- Next Steps must be practical, sequenced, and clear enough for a client to act on.

Anti-filler requirement:
The proposal must gain length through real depth, specificity, client-relevant analysis, concrete examples, and professional detail. Never increase length through repetition, generic filler, empty phrases, vague claims, or padded wording. Write like a senior commercial consultant preparing a serious client-facing proposal.

Respect the 900-1300 word target as closely as possible while preserving quality, the required HTML structure, the exact section headings, the requested language, the custom prompt, and all pricing rules.
""".strip(),
        "extended": """
Generate an extensive professional proposal of approximately 1100-1400 words, designed to produce 5-6 pages maximum when rendered. Never exceed 6 rendered pages.

Depth requirement:
- Develop every required section in depth, but stay concise enough for a 5-6 page final document.
- Executive Summary must be broad and consultative, explaining the client's business context, why the opportunity matters, and the strategic value of the proposed engagement.
- Problems Identified must include several detailed points with operational, financial, process, quality, or growth implications based on the client description, detailed process, industry, and team sizing provided.
- Proposed AI Solution must explain the recommended approach, operating model, workflow, technologies, implementation logic, and how the solution addresses each identified problem.
- Implementation Costs must use ONLY the provided pricing data. Do not invent, rename, remove, merge, or add services or prices.
- Expected ROI must include concrete business impact areas, operational metrics, efficiency gains, quality improvements, risk reduction, and measurable outcomes where appropriate. Do not invent unsupported financial figures.
- Include risks, constraints, assumptions, and mitigations inside the most relevant sections when applicable, especially in Proposed AI Solution or Expected ROI.
- Next Steps must be detailed and practical, with clear sequencing, stakeholder actions, validation activities, and decision points, without expanding beyond what is needed for the 5-6 page maximum.

Anti-filler requirement:
The proposal must gain length through real depth, specificity, client-relevant analysis, concrete examples, and professional detail. Never increase length through repetition, generic filler, empty phrases, vague claims, or padded wording. Write like a senior commercial consultant preparing a serious client-facing proposal.

Respect the 1100-1400 word target and the hard maximum of 6 rendered pages. If there is any conflict between depth and page count, prioritize the 6-page maximum while preserving quality, the required HTML structure, the exact section headings, the requested language, the custom prompt, and all pricing rules.
""".strip(),
    }
    pricing_context = _format_proposal_line_items(line_items, total_amount)
    rag_context = get_rag_context(
        client_name=client_name,
        service_type=description,
    )
    prompt = f"""
{rag_context}

Generate a PREMIUM commercial proposal in the following language: {language}.

Title: {title}
Client: {client_name}
Description: {description}
Detailed client process: {detailed_description or "Not provided"}
Team sizing and roles: {team_sizing or "Not provided"}

PRIORITY STYLE AND FOCUS INSTRUCTION:
{custom_prompt or "No additional instruction provided."}

LENGTH REQUIREMENT:
{length_instructions[length]}

CONTENT QUALITY INSTRUCTIONS:
- Each section must be developed with real client-specific analysis, not generic filler.
- Problems Identified: exactly 4-5 problems, each with a clear problem name and 2-3 sentences explaining concrete impact on this specific client's business.
- Proposed AI Solution: describe the real operating workflow step by step, with concrete technical logic. Do not say "advanced AI" generically; explain what type of model or automation is used and what it does.
- Technologies Used: exactly 4-6 technologies, each with a real technical name and an explanation of why it applies to this specific case.
- Expected ROI: include at least 3 projected metrics with justified percentages or numeric ranges. Do not invent unsupported financial figures or costs.
- Next Steps: include 4-5 sequenced steps with estimated weeks.
- Forbidden: paragraphs longer than 5 consecutive sentences, empty phrases such as "comprehensive solution", "holistic approach", or "cutting-edge" without substance, and repeating information already stated in another section.
- Format Problems Identified and Technologies Used list items as "Clear item name: 2-3 sentence explanation" so the renderer can emphasize the item name without making the whole item bold.

PRICING DATA AND NON-NEGOTIABLE RULES:
{pricing_context}

IMPORTANT RULES:
- Respond ONLY with a clean semantic HTML fragment.
- Do not include <html>, <body>, <article>, or any outer <div> container.
- Do not use inline styles, style attributes, CSS classes, markdown, **, ###, ---, or backticks.
- Use only these HTML tags: <h1>, <h2>, <p>, <ul>, <li>, <table>, <thead>, <tbody>, <tr>, <th>, and <td>.
- Use short paragraphs, semantic lists, and professional HTML tables. The frontend, PDF, and DOCX renderers control all visual design.
- Keep these exact English section headings as structural markers; write ALL
  body text, descriptions, labels, and table content in {language}.
- Follow the PRIORITY STYLE AND FOCUS INSTRUCTION above when provided.
- Use the detailed client process and team sizing when provided.
- The pricing table must follow the PRICING DATA AND NON-NEGOTIABLE RULES exactly.

REQUIRED STRUCTURE:
<h1>Proposal title</h1>
<p>Professional subtitle</p>
<h2>Executive Summary</h2>
<p>Separate text into short paragraphs.</p>
<h2>Problems Identified</h2>
<ul><li>Relevant client problem</li></ul>
<h2>Proposed AI Solution</h2>
<p>Professional explanation based on the provided client context.</p>
<h2>Technologies Used</h2>
<ul><li>Relevant technology or capability</li></ul>
<h2>Implementation Costs</h2>
<table><thead><tr><th>Service / Unit</th><th>Description</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th></tr></thead><tbody><tr><td>Use provided pricing data only</td><td>Use provided pricing data only</td><td>Use provided pricing data only</td><td>Use provided pricing data only</td><td>Use provided pricing data only</td></tr></tbody></table>
<h2>Expected ROI</h2>
<p>Professional financial explanation.</p>
<h2>Next Steps</h2>
<p>Professional closing and recommended actions.</p>
"""

    content = await deepseek_service.generate_text(
        prompt,
        system_prompt="You are an expert marketing proposal writer.",
        temperature=0.7,
        timeout=settings.llm_long_timeout_seconds,
    )

    output_dir = _output_dir()
    filename = f"proposal-{uuid.uuid4()}.md"
    file_path = output_dir / filename
    file_path.write_text(content, encoding="utf-8")

    return {
        "content": content,
        "downloadUrl": str(file_path),
        "filePath": str(file_path),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=List[ProposalOut])
async def get_proposals(
    search: Optional[str] = Query(None, description="Búsqueda parcial en título o cliente"),
    limit: int = Query(200, ge=1, le=500),
    user: CurrentUser = Depends(get_current_user),
):
    proposals = await proposals_repo.list(
        filters=[("userId", "==", user.sub)],
        order_by="updatedAt",
        order_direction="DESCENDING",
        limit=limit,
    )
    if search:
        s = search.lower()
        proposals = [
            p for p in proposals
            if s in (p.get("title") or "").lower() or s in (p.get("clientName") or "").lower()
        ]
    return proposals


@router.post("", response_model=ProposalOut, status_code=status.HTTP_201_CREATED)
async def create_proposal(
    body: ProposalCreate,
    user: CurrentUser = Depends(get_current_user),
):
    data = body.model_dump(exclude_none=True)

    client_name = (
        data.get("clientName")
        or data.get("client")
        or data.get("company")
        or data.get("customer_name")
        or data.get("customer")
        or "Demo Client"
    )
    description = (
        data.get("description")
        or data.get("brief")
        or data.get("summary")
        or data.get("proposal_description")
        or ""
    )
    content = data.get("content") or description

    proposal = {
        **data,
        "title": data["title"],
        "clientName": client_name,
        "description": description,
        "content": content,
        "downloadUrl": None,
        "filePath": None,
        "status": data.get("status") or "draft",
        "proposal_status": data.get("proposal_status") or "Generada",
        "userId": user.sub,
    }
    if data.get("opportunity_id"):
        proposal["opportunity_id"] = data["opportunity_id"]
    return await proposals_repo.create(proposal, doc_id=str(uuid.uuid4()))


@router.get("/{proposal_id}", response_model=ProposalOut)
async def get_proposal(proposal_id: str, user: CurrentUser = Depends(get_current_user)):
    return await _get_proposal_for_user(proposal_id, user.sub)


@router.post("/generate-draft", response_model=ProposalOut, status_code=status.HTTP_201_CREATED)
@limiter.limit("20/minute")
async def generate_proposal_draft(
    request: Request,
    body: GenerateProposalRequest,
    user: CurrentUser = Depends(get_current_user),
):
    extra = body.model_extra or {}
    title = body.title or extra.get("name") or "AI Marketing Proposal"
    client_name = (
        body.clientName
        or extra.get("client")
        or extra.get("company")
        or extra.get("customer_name")
        or extra.get("customer")
        or "Demo Client"
    )
    description = (
        body.description
        or extra.get("brief")
        or extra.get("summary")
        or extra.get("proposalDescription")
        or extra.get("proposal_description")
        or ""
    )

    line_items = body.lineItems
    if line_items is None:
        line_items = extra.get("pricingRows") or extra.get("pricing_rows")
    normalized_line_items = [
        item.model_dump() if hasattr(item, "model_dump") else item
        for item in (line_items or [])
    ]

    generated = await _generate_proposal_content(
        title,
        client_name,
        description,
        detailed_description=body.detailedDescription or extra.get("detailed_description"),
        team_sizing=body.teamSizing or extra.get("team_sizing"),
        line_items=normalized_line_items,
        total_amount=body.totalAmount if body.totalAmount is not None else extra.get("total_amount"),
        length=body.length,
        language=body.language,
        custom_prompt=body.customPrompt,
    )

    proposal = {
        "title": title,
        "clientName": client_name,
        "description": description,
        "content": generated["content"],
        "downloadUrl": generated["downloadUrl"],
        "filePath": generated["filePath"],
        "status": "generated",
        "language": body.language,
        "customPrompt": body.customPrompt,
        "userId": user.sub,
    }
    return await proposals_repo.create(proposal, doc_id=str(uuid.uuid4()))


@router.post("/{proposal_id}/generate", response_model=ProposalOut)
@limiter.limit("20/minute")
async def generate_proposal_by_id(
    request: Request,
    proposal_id: str,
    body: GenerateProposalRequest,
    user: CurrentUser = Depends(get_current_user),
):
    proposal = await _get_proposal_for_user(proposal_id, user.sub)

    title = body.title or proposal.get("title") or "AI Marketing Proposal"
    client_name = body.clientName or proposal.get("clientName") or "Demo Client"
    description = body.description or proposal.get("description") or ""

    generated = await _generate_proposal_content(
        title,
        client_name,
        description,
        detailed_description=body.detailedDescription,
        team_sizing=body.teamSizing,
        line_items=[item.model_dump() for item in (body.lineItems or [])],
        total_amount=body.totalAmount,
        length=body.length,
        language=body.language,
        custom_prompt=body.customPrompt,
    )
    return await proposals_repo.update(proposal_id, {
        "content": generated["content"],
        "downloadUrl": generated["downloadUrl"],
        "filePath": generated["filePath"],
        "status": "generated",
        "language": body.language,
        "customPrompt": body.customPrompt,
    })


@router.put("/{proposal_id}", response_model=ProposalOut)
async def update_proposal(
    proposal_id: str,
    body: ProposalUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    await _get_proposal_for_user(proposal_id, user.sub)
    update_data = body.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update."
        )
    return await proposals_repo.update(proposal_id, update_data)


@router.patch("/{proposal_id}/status")
async def update_proposal_status(
    proposal_id: str,
    body: dict,
    current_user: CurrentUser = Depends(get_current_user),
):
    new_status = body.get("status")
    if new_status not in PROPOSAL_STATUS_SCORES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid proposal status.",
        )

    proposal = await _get_proposal_for_user(proposal_id, current_user.sub)
    updated = await proposals_repo.update(proposal_id, {"proposal_status": new_status})

    opportunity_id = proposal.get("opportunity_id")
    if opportunity_id:
        try:
            opportunity = await opportunities_repo.get_or_404(opportunity_id)
        except KeyError:
            opportunity = None
        if opportunity and opportunity.get("userId") == current_user.sub:
            await opportunities_repo.update(
                opportunity_id,
                {"score": PROPOSAL_STATUS_SCORES[new_status]},
            )

    return updated


@router.delete("/{proposal_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_proposal(proposal_id: str, user: CurrentUser = Depends(get_current_user)):
    await _get_proposal_for_user(proposal_id, user.sub)
    await proposals_repo.delete(proposal_id)
    return None


@router.get("/{proposal_id}/versions")
async def list_proposal_versions(proposal_id: str, user: CurrentUser = Depends(get_current_user)):
    proposal = await _get_proposal_for_user(proposal_id, user.sub)
    versions = proposal.get("versions") or []
    if not versions:
        versions = [{
            "version": 1,
            "title": proposal.get("title"),
            "content": proposal.get("content") or proposal.get("description") or "",
            "createdAt": proposal.get("createdAt"),
            "label": "Current",
        }]
    return {"items": versions, "total": len(versions)}


@router.post("/{proposal_id}/versions")
async def create_proposal_version(
    proposal_id: str,
    body: ProposalVersionCreate,
    user: CurrentUser = Depends(get_current_user),
):
    proposal = await _get_proposal_for_user(proposal_id, user.sub)
    versions = list(proposal.get("versions") or [])
    version = {
        "version": len(versions) + 1,
        "title": body.title or proposal.get("title"),
        "content": body.content or proposal.get("content") or "",
        "label": body.label or f"Version {len(versions) + 1}",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    versions.append(version)
    await proposals_repo.update(proposal_id, {"versions": versions})
    return version


@router.post("/{proposal_id}/send-to-crm")
async def send_proposal_to_crm(
    proposal_id: str,
    body: SendToCrmRequest,
    user: CurrentUser = Depends(get_current_user),
):
    proposal = await _get_proposal_for_user(proposal_id, user.sub)
    crm_sync = {
        "provider": body.provider or "manual",
        "status": "queued",
        "queuedAt": datetime.now(timezone.utc).isoformat(),
        "clientName": proposal.get("clientName"),
    }
    return await proposals_repo.update(proposal_id, {"crmSync": crm_sync})


@router.get("/{proposal_id}/download")
async def download_proposal(
    proposal_id: str,
    format: str = Query("pdf", pattern="^(pdf|docx)$"),
    user: CurrentUser = Depends(get_current_user),
):
    proposal = await _get_proposal_for_user(proposal_id, user.sub)

    title = proposal.get("title") or "proposal"
    html_content = proposal.get("content", "")
    cover = _proposal_cover_fields(proposal)

    output_dir = _output_dir()
    safe_title = title.replace(" ", "_").replace("/", "_").lower()

    if format == "docx":
        file_path = output_dir / f"{safe_title}-{proposal_id}.docx"
        _build_proposal_docx(file_path, title, html_content, cover)

        return FileResponse(
            path=file_path,
            filename=file_path.name,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )

    file_path = output_dir / f"{safe_title}-{proposal_id}.pdf"
    _build_proposal_pdf(file_path, title, html_content, cover)

    return FileResponse(
        path=file_path,
        filename=file_path.name,
        media_type="application/pdf",
    )
