"""Backend PDF renderers for Content Library generated content items."""
from __future__ import annotations

from io import BytesIO
from typing import Any
from xml.sax.saxutils import escape

from bs4 import BeautifulSoup
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.rendering.brand_styles import (
    BRAND_BODY_TEXT,
    BRAND_BORDER,
    BRAND_DEEP_NAVY,
    BRAND_MUTED,
    BRAND_NAVY,
    BRAND_PRIMARY_INDIGO,
    BRAND_SOFT_INDIGO_SURFACE,
    BRAND_SURFACE,
    BRAND_TEXT,
)
from app.rendering.html_flowables import html_to_flowables, inline_markup


def content_page_decoration(canvas_obj, _doc_template):
    canvas_obj.saveState()
    canvas_obj.setStrokeColor(colors.HexColor(BRAND_BORDER))
    canvas_obj.setLineWidth(0.5)
    canvas_obj.line(54, 40, LETTER[0] - 54, 40)
    canvas_obj.setFont("Helvetica", 8)
    canvas_obj.setFillColor(colors.HexColor(BRAND_MUTED))
    canvas_obj.drawString(54, 28, "NoonDalton AI Marketing Suite")
    canvas_obj.drawRightString(LETTER[0] - 54, 28, f"Page {canvas_obj.getPageNumber()}")
    canvas_obj.restoreState()


def _template_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("TplTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=24, leading=29, textColor=colors.HexColor(BRAND_DEEP_NAVY), alignment=0, spaceAfter=8),
        "eyebrow": ParagraphStyle("TplEyebrow", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=colors.HexColor(BRAND_PRIMARY_INDIGO), spaceAfter=4),
        "badge": ParagraphStyle("TplBadge", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=colors.HexColor(BRAND_NAVY)),
        "label": ParagraphStyle("TplLabel", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=8.5, leading=11, textColor=colors.HexColor(BRAND_MUTED), spaceAfter=4),
        "subject": ParagraphStyle("TplSubject", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=colors.HexColor(BRAND_DEEP_NAVY)),
        "body": ParagraphStyle("TplBody", parent=base["BodyText"], fontName="Helvetica", fontSize=10.5, leading=16, textColor=colors.HexColor(BRAND_TEXT), spaceAfter=8),
        "message": ParagraphStyle("TplMessage", parent=base["BodyText"], fontName="Helvetica", fontSize=10.5, leading=16, textColor=colors.HexColor(BRAND_BODY_TEXT), spaceAfter=8),
        "section": ParagraphStyle("TplSection", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, leading=15, textColor=colors.HexColor(BRAND_NAVY), spaceBefore=6, spaceAfter=8),
        "code": ParagraphStyle("TplCode", parent=base["BodyText"], fontName="Courier", fontSize=8.5, leading=12, textColor=colors.HexColor(BRAND_DEEP_NAVY), spaceAfter=5),
        "subheading": ParagraphStyle("TplSubheading", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=14, leading=17, textColor=colors.HexColor(BRAND_NAVY), spaceBefore=12, spaceAfter=8),
        "small": ParagraphStyle("TplSmall", parent=base["Normal"], fontName="Helvetica", fontSize=8.5, leading=11, textColor=colors.HexColor(BRAND_MUTED)),
        "blockquote": ParagraphStyle("TplQuote", parent=base["BodyText"], fontName="Helvetica-Oblique", fontSize=11, leading=16, textColor=colors.HexColor(BRAND_NAVY)),
        "metricValue": ParagraphStyle("TplMetricValue", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=17, leading=20, textColor=colors.HexColor(BRAND_PRIMARY_INDIGO), alignment=1),
        "metricLabel": ParagraphStyle("TplMetricLabel", parent=base["Normal"], fontName="Helvetica", fontSize=8.5, leading=11, textColor=colors.HexColor(BRAND_BODY_TEXT), alignment=1),
        "cta": ParagraphStyle("TplCta", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=12, leading=16, textColor=colors.white, spaceAfter=4),
        "ctaUrl": ParagraphStyle("TplCtaUrl", parent=base["BodyText"], fontName="Courier", fontSize=9, leading=12, textColor=colors.HexColor(BRAND_SOFT_INDIGO_SURFACE)),
    }


def _first_text(tag, selector: str | None = None) -> str:
    target = tag.select_one(selector) if selector else tag
    return target.get_text(" ", strip=True) if target else ""


def _panel(rows, *, background: str, border: str = BRAND_BORDER, padding: int = 12):
    table = Table(rows, colWidths=[LETTER[0] - 108])
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


def _badge_row(values: list[str], styles: dict):
    clean_values = [value for value in values if value]
    if not clean_values:
        return None
    table = Table(
        [[Paragraph(escape(value.upper()), styles["badge"]) for value in clean_values]],
        colWidths=[min(150, (LETTER[0] - 108) / len(clean_values))] * len(clean_values),
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(BRAND_SOFT_INDIGO_SURFACE)),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor(BRAND_BORDER)),
        ("INNERGRID", (0, 0), (-1, -1), 0.6, colors.HexColor(BRAND_BORDER)),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def _extract_first(soup, selector: str):
    node = soup.select_one(selector)
    if node:
        node.extract()
    return node


def _extract_all(soup, selector: str) -> list:
    nodes = list(soup.select(selector))
    for node in nodes:
        node.extract()
    return nodes


def _span_values(tag) -> list[str]:
    return [span.get_text(" ", strip=True) for span in tag.find_all("span", recursive=False)] if tag else []


def _metric_grid(tag, styles: dict, metric_class: str) -> list:
    cells = []
    for metric in tag.select(f".{metric_class}"):
        value = metric.select_one(f".{metric_class}-value")
        label = metric.select_one(f".{metric_class}-label")
        value_text = value.get_text(" ", strip=True) if value else ""
        label_text = label.get_text(" ", strip=True) if label else ""
        if value_text or label_text:
            cells.append([
                Paragraph(escape(value_text), styles["metricValue"]),
                Paragraph(escape(label_text), styles["metricLabel"]),
            ])
    if not cells:
        return []
    table = Table(
        [cells],
        colWidths=[(LETTER[0] - 108) / len(cells)] * len(cells),
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(BRAND_SOFT_INDIGO_SURFACE)),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor(BRAND_BORDER)),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor(BRAND_BORDER)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
    ]))
    return [table, Spacer(1, 14)]


def _testimonial_panel(tag, styles: dict) -> list:
    text = inline_markup(tag)
    if not text:
        return []
    return [_panel([[Paragraph(text, styles["blockquote"])]], background="#ffffff", border=BRAND_PRIMARY_INDIGO), Spacer(1, 12)]


def _cta_panel(tag, styles: dict) -> list:
    rows = []
    for child in tag.find_all(["p", "a"], recursive=False):
        text = inline_markup(child)
        if text:
            rows.append([Paragraph(text, styles["ctaUrl"] if child.name == "a" else styles["cta"])])
    if not rows:
        text = inline_markup(tag)
        rows = [[Paragraph(text, styles["cta"])]] if text else []
    return [_panel(rows, background=BRAND_DEEP_NAVY, border=BRAND_DEEP_NAVY), Spacer(1, 12)] if rows else []


def _build_document(story: list, *, top_margin: int = 48) -> bytes:
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=LETTER,
        leftMargin=54,
        rightMargin=54,
        topMargin=top_margin,
        bottomMargin=56,
    )
    doc.build(story, onFirstPage=content_page_decoration, onLaterPages=content_page_decoration)
    return buffer.getvalue()


def _template_pdf(html: str, metadata: dict[str, Any] | None = None) -> bytes:
    soup = BeautifulSoup(html or "", "html.parser")
    styles = _template_styles()
    metadata = metadata or {}

    title = _first_text(soup, "h1") or metadata.get("title") or "Template"
    meta = soup.select_one(".tpl-meta")
    subject = soup.select_one(".tpl-subject")
    body = soup.select_one(".tpl-body")
    variables = soup.select_one(".tpl-variables")

    story = [
        Paragraph("COMMUNICATION TEMPLATE", styles["eyebrow"]),
        Paragraph(escape(title), styles["title"]),
    ]
    badge_values = [_first_text(meta, ".tpl-channel"), _first_text(meta, ".tpl-category"), _first_text(meta, ".tpl-tone")] if meta else []
    badges = _badge_row(badge_values, styles)
    if badges:
        story.extend([badges, Spacer(1, 18)])

    if subject:
        label = subject.find("strong")
        label_text = label.get_text(" ", strip=True) if label else "Subject line:"
        subject_text = _first_text(subject, "p") or subject.get_text(" ", strip=True).replace(label_text, "", 1).strip()
        story.append(_panel([
            [Paragraph(escape(label_text), styles["label"])],
            [Paragraph(escape(subject_text), styles["subject"])],
        ], background=BRAND_SOFT_INDIGO_SURFACE, border=BRAND_PRIMARY_INDIGO))
        story.append(Spacer(1, 14))

    if body:
        body_rows = [[Paragraph("MESSAGE BODY", styles["label"])]]
        for paragraph in body.find_all("p", recursive=False):
            text = inline_markup(paragraph)
            if text:
                body_rows.append([Paragraph(text, styles["message"])])
        story.append(_panel(body_rows, background=BRAND_SURFACE))
        story.append(Spacer(1, 16))

    if variables:
        variable_rows = [[Paragraph(_first_text(variables, "h2") or "Merge Variables", styles["section"])]]
        items = variables.find_all("li")
        if items:
            for item in items:
                variable_rows.append([Paragraph(escape(item.get_text(" ", strip=True)), styles["code"])])
        else:
            variable_rows.extend([[flowable] for flowable in html_to_flowables(str(variables), styles)])
        story.append(_panel(variable_rows, background="#ffffff"))

    return _build_document(story)


def _case_study_pdf(html: str, metadata: dict[str, Any] | None = None) -> bytes:
    soup = BeautifulSoup(html or "", "html.parser")
    styles = _template_styles()
    metadata = metadata or {}
    title_node = _extract_first(soup, "h1")
    meta_node = _extract_first(soup, ".cs-meta")
    metrics_node = _extract_first(soup, ".cs-metrics")

    story = [
        Paragraph("CASE STUDY", styles["eyebrow"]),
        Paragraph(escape(_first_text(title_node) or metadata.get("title") or "Case Study"), styles["title"]),
    ]
    badges = _badge_row(_span_values(meta_node), styles)
    if badges:
        story.extend([badges, Spacer(1, 14)])
    if metrics_node:
        story.extend(_metric_grid(metrics_node, styles, "cs-metric"))
    story.extend(html_to_flowables(str(soup), styles, class_renderers={"cs-testimonial": _testimonial_panel}))
    return _build_document(story)


def _whitepaper_pdf(html: str, metadata: dict[str, Any] | None = None) -> bytes:
    soup = BeautifulSoup(html or "", "html.parser")
    styles = _template_styles()
    metadata = metadata or {}
    title_node = _extract_first(soup, "h1")
    subtitle_node = _extract_first(soup, ".wp-subtitle")
    meta_node = _extract_first(soup, ".wp-meta")

    story = [
        Paragraph("WHITEPAPER", styles["eyebrow"]),
        Paragraph(escape(_first_text(title_node) or metadata.get("title") or "Whitepaper"), styles["title"]),
    ]
    if subtitle_node:
        story.append(Paragraph(inline_markup(subtitle_node), styles["subject"]))
        story.append(Spacer(1, 10))
    badges = _badge_row(_span_values(meta_node), styles)
    if badges:
        story.extend([badges, Spacer(1, 16)])
    story.extend(html_to_flowables(str(soup), styles))
    return _build_document(story)


def _one_pager_pdf(html: str, metadata: dict[str, Any] | None = None) -> bytes:
    soup = BeautifulSoup(html or "", "html.parser")
    styles = _template_styles()
    metadata = metadata or {}
    title_node = _extract_first(soup, "h1")
    tagline_node = _extract_first(soup, ".op-tagline")
    intro_node = _extract_first(soup, ".op-intro")

    story = [
        Paragraph("ONE-PAGER", styles["eyebrow"]),
        Paragraph(escape(_first_text(title_node) or metadata.get("title") or "One-Pager"), styles["title"]),
    ]
    if tagline_node:
        story.append(Paragraph(inline_markup(tagline_node), styles["subject"]))
        story.append(Spacer(1, 8))
    if intro_node:
        story.append(_panel([[Paragraph(inline_markup(intro_node), styles["message"])]], background=BRAND_SURFACE))
        story.append(Spacer(1, 14))
    story.extend(html_to_flowables(
        str(soup),
        styles,
        class_renderers={
            "op-metrics": lambda tag, current_styles: _metric_grid(tag, current_styles, "op-metric"),
            "op-cta": _cta_panel,
        },
    ))
    return _build_document(story)


def build_content_item_pdf(item_type: str, html: str, metadata: dict[str, Any] | None = None) -> bytes:
    normalized = (item_type or "").strip().lower().replace("-", "_")
    if normalized == "template":
        return _template_pdf(html, metadata)
    if normalized == "case_study":
        return _case_study_pdf(html, metadata)
    if normalized == "whitepaper":
        return _whitepaper_pdf(html, metadata)
    if normalized == "one_pager":
        return _one_pager_pdf(html, metadata)
    raise ValueError(f"Backend PDF rendering is not available for content item type '{item_type}'.")
