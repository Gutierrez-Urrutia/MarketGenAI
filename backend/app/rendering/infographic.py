"""ReportLab renderer for Book Concepts infographic assets."""
from __future__ import annotations

from io import BytesIO
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.rendering.brand_styles import (
    BRAND_BODY_TEXT,
    BRAND_BORDER,
    BRAND_DEEP_NAVY,
    BRAND_MUTED,
    BRAND_PRIMARY_INDIGO,
    BRAND_SOFT_INDIGO_SURFACE,
    BRAND_SURFACE,
    BRAND_TEXT,
)


def _text(value: Any, fallback: str = "") -> str:
    return str(value if value is not None else fallback).strip()


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "eyebrow": ParagraphStyle("InfographicEyebrow", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=8.5, leading=11, textColor=colors.HexColor(BRAND_PRIMARY_INDIGO), spaceAfter=8),
        "title": ParagraphStyle("InfographicTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=27, leading=32, textColor=colors.HexColor(BRAND_DEEP_NAVY), spaceAfter=8),
        "subtitle": ParagraphStyle("InfographicSubtitle", parent=base["BodyText"], fontName="Helvetica", fontSize=12, leading=17, textColor=colors.HexColor(BRAND_BODY_TEXT), spaceAfter=2),
        "stat": ParagraphStyle("InfographicStat", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=22, leading=25, textColor=colors.HexColor(BRAND_PRIMARY_INDIGO), alignment=1),
        "cardHeading": ParagraphStyle("InfographicCardHeading", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, leading=15, textColor=colors.HexColor(BRAND_DEEP_NAVY), spaceAfter=5),
        "cardBody": ParagraphStyle("InfographicCardBody", parent=base["BodyText"], fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=colors.HexColor(BRAND_BODY_TEXT)),
        "sectionLabel": ParagraphStyle("InfographicSectionLabel", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=9, leading=11, textColor=colors.HexColor(BRAND_MUTED), spaceBefore=4, spaceAfter=8),
        "bullet": ParagraphStyle("InfographicBullet", parent=base["BodyText"], fontName="Helvetica", fontSize=10.5, leading=15, textColor=colors.HexColor(BRAND_TEXT)),
        "cta": ParagraphStyle("InfographicCta", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=13, leading=17, textColor=colors.white, alignment=1),
        "footer": ParagraphStyle("InfographicFooter", parent=base["Normal"], fontName="Helvetica", fontSize=8, leading=10, textColor=colors.HexColor(BRAND_MUTED), alignment=1),
    }


def _page_decoration(canvas_obj, _doc_template):
    canvas_obj.saveState()
    canvas_obj.setFillColor(colors.HexColor(BRAND_PRIMARY_INDIGO))
    canvas_obj.rect(0, LETTER[1] - 10, LETTER[0], 10, stroke=0, fill=1)
    canvas_obj.setStrokeColor(colors.HexColor(BRAND_BORDER))
    canvas_obj.setLineWidth(0.5)
    canvas_obj.line(54, 40, LETTER[0] - 54, 40)
    canvas_obj.setFont("Helvetica", 8)
    canvas_obj.setFillColor(colors.HexColor(BRAND_MUTED))
    canvas_obj.drawString(54, 28, "NoonDalton AI Marketing Suite")
    canvas_obj.drawRightString(LETTER[0] - 54, 28, f"Page {canvas_obj.getPageNumber()}")
    canvas_obj.restoreState()


def _panel(rows, *, background: str, border: str = BRAND_BORDER, padding: int = 12, col_widths: list[float] | None = None):
    table = Table(rows, colWidths=col_widths or [LETTER[0] - 108])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(background)),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor(border)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), padding),
        ("RIGHTPADDING", (0, 0), (-1, -1), padding),
        ("TOPPADDING", (0, 0), (-1, -1), padding),
        ("BOTTOMPADDING", (0, 0), (-1, -1), padding),
    ]))
    return table


def _section_card(section: dict[str, Any], index: int, styles: dict[str, ParagraphStyle]):
    stat = _text(section.get("stat"), str(index + 1))
    heading = _text(section.get("heading"), f"Insight {index + 1}")
    description = _text(section.get("description"))
    rows = [[
        Paragraph(escape(stat), styles["stat"]),
        [
            Paragraph(escape(heading), styles["cardHeading"]),
            Paragraph(escape(description), styles["cardBody"]) if description else Spacer(1, 1),
        ],
    ]]
    return _panel(
        rows,
        background="#ffffff",
        border=BRAND_BORDER,
        padding=10,
        col_widths=[86, LETTER[0] - 214],
    )


def build_infographic_pdf(data: dict[str, Any], metadata: dict[str, Any] | None = None) -> bytes:
    """Build a branded PDF from the current infographic JSON structure."""
    metadata = metadata or {}
    styles = _styles()
    title = _text(data.get("title"), metadata.get("title") or "Infographic")
    subtitle = _text(data.get("subtitle"), metadata.get("subtitle") or metadata.get("description") or "")
    sections = data.get("sections") if isinstance(data.get("sections"), list) else []
    key_points = data.get("keyPoints") if isinstance(data.get("keyPoints"), list) else []
    call_to_action = _text(data.get("callToAction"))

    hero_rows = [
        [Paragraph("BOOK CONCEPTS INFOGRAPHIC", styles["eyebrow"])],
        [Paragraph(escape(title), styles["title"])],
    ]
    if subtitle:
        hero_rows.append([Paragraph(escape(subtitle), styles["subtitle"])])

    story = [
        _panel(hero_rows, background=BRAND_SOFT_INDIGO_SURFACE, border=BRAND_PRIMARY_INDIGO, padding=18),
        Spacer(1, 16),
    ]

    if sections:
        story.append(Paragraph("KEY SIGNALS", styles["sectionLabel"]))
        for index, section in enumerate(sections):
            if isinstance(section, dict):
                story.append(_section_card(section, index, styles))
                story.append(Spacer(1, 9))

    if key_points:
        rows = [[Paragraph("TAKEAWAYS", styles["sectionLabel"])]]
        for point in key_points:
            point_text = _text(point)
            if point_text:
                rows.append([Paragraph(f"<b>&bull;</b> {escape(point_text)}", styles["bullet"])])
        if len(rows) > 1:
            story.extend([
                Spacer(1, 4),
                _panel(rows, background=BRAND_SURFACE, border=BRAND_BORDER, padding=14),
                Spacer(1, 14),
            ])

    if call_to_action:
        story.append(_panel(
            [[Paragraph(escape(call_to_action), styles["cta"])]],
            background=BRAND_DEEP_NAVY,
            border=BRAND_DEEP_NAVY,
            padding=16,
        ))

    story.extend([
        Spacer(1, 16),
        Paragraph(escape(_text(metadata.get("book_title"), "")), styles["footer"]),
    ])

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=LETTER,
        leftMargin=54,
        rightMargin=54,
        topMargin=46,
        bottomMargin=56,
    )
    doc.build(story, onFirstPage=_page_decoration, onLaterPages=_page_decoration)
    return buffer.getvalue()
