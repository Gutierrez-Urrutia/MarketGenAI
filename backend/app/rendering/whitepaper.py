"""Whitepaper PDF con aspecto profesional (ReportLab, sin librerías nativas del sistema).

Estructura: portada a página completa, índice con números de página, un capítulo por página
nueva con número y título destacados, cuadros de idea clave (callouts), encabezado con el título
del libro y pie con marca y «Página X de Y».

Vive aparte de ``brand_styles.content_base_styles`` a propósito: esos estilos los comparten el
one-pager, las propuestas y otros documentos, y el whitepaper no debe cambiarlos.
"""
from __future__ import annotations

from datetime import datetime
from io import BytesIO
from typing import Any, Dict, List
from xml.sax.saxutils import escape

from bs4 import BeautifulSoup
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

from app.core.languages import normalize_language
from app.rendering import proposal_brand as brand
from app.rendering.brand_styles import brand_color, content_base_styles
from app.rendering.html_flowables import html_to_flowables, text_or_markdown_to_html

PAGE_W, PAGE_H = LETTER
MARGIN_X = 62
BRAND_NAME = "NoonDalton AI Marketing Suite"

# Marca de NoonDalton (la misma que usa la exportación de propuestas).
BRAND_PRIMARY_INDIGO = brand.PRIMARY          # verde azulado: etiquetas, viñetas, barras
BRAND_DEEP_NAVY = brand.PRIMARY_DEEP          # fondo de la portada
BRAND_NAVY = brand.PRIMARY_DEEP               # títulos
BRAND_SOFT_INDIGO_SURFACE = brand.PRIMARY_TINT
BRAND_TEXT, BRAND_MUTED, BRAND_BORDER = brand.TEXT, brand.MUTED, brand.BORDER
ACCENT = brand.ACCENT                         # naranja: solo líneas y barras, nunca texto pequeño
COVER_EYEBROW = brand._mix(brand.PRIMARY, brand.WHITE, 0.7)
COVER_SUBTITLE = brand._mix(brand.PRIMARY, brand.WHITE, 0.85)

LABELS = {
    "es": {"page": "Página", "of": "de", "chapter": "CAPÍTULO", "contents": "Contenido", "whitepaper": "WHITEPAPER"},
    "en": {"page": "Page", "of": "of", "chapter": "CHAPTER", "contents": "Contents", "whitepaper": "WHITEPAPER"},
    "pt": {"page": "Página", "of": "de", "chapter": "CAPÍTULO", "contents": "Conteúdo", "whitepaper": "WHITEPAPER"},
}
MONTHS = {
    "es": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    "pt": ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
    "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
}


def format_date(language: str, when: datetime | None = None) -> str:
    when = when or datetime.now()
    lang = normalize_language(language)
    if lang not in MONTHS:
        lang = "en"
    month = MONTHS[lang][when.month - 1]
    if lang == "en":
        return f"{month} {when.day}, {when.year}"
    return f"{when.day} de {month} de {when.year}"


def _labels(language: str) -> dict:
    return LABELS.get(normalize_language(language), LABELS["en"])


def whitepaper_styles() -> Dict[str, ParagraphStyle]:
    styles = dict(content_base_styles())
    base = styles["body"]
    styles.update({
        "wpEyebrow": ParagraphStyle("WpEyebrow", parent=base, fontName="Helvetica-Bold", fontSize=9, leading=12,
                                    textColor=colors.HexColor(COVER_EYEBROW), alignment=0, spaceAfter=18),
        "wpCoverTitle": ParagraphStyle("WpCoverTitleX", parent=base, fontName="Helvetica-Bold", fontSize=34, leading=40,
                                       textColor=colors.white, alignment=0, spaceAfter=18),
        "wpCoverSubtitle": ParagraphStyle("WpCoverSubtitleX", parent=base, fontSize=13.5, leading=20,
                                          textColor=colors.HexColor(COVER_SUBTITLE), alignment=0, spaceAfter=0),
        "wpChapterLabel": ParagraphStyle("WpChapterLabel", parent=base, fontName="Helvetica-Bold", fontSize=9.5, leading=12,
                                         textColor=brand_color(BRAND_PRIMARY_INDIGO), alignment=0, spaceBefore=28, spaceAfter=4),
        "wpChapterTitle": ParagraphStyle("WpChapterTitleX", parent=base, fontName="Helvetica-Bold", fontSize=25, leading=30,
                                         textColor=brand_color(BRAND_NAVY), alignment=0, spaceAfter=10),
        "wpTocTitle": ParagraphStyle("WpTocTitle", parent=base, fontName="Helvetica-Bold", fontSize=24, leading=28,
                                     textColor=brand_color(BRAND_NAVY), alignment=0, spaceBefore=28, spaceAfter=10),
        "wpToc": ParagraphStyle("WpToc", parent=base, fontSize=11.5, leading=16, textColor=brand_color(BRAND_TEXT),
                                alignment=0, leftIndent=0, spaceAfter=7),
        "wpCallout": ParagraphStyle("WpCallout", parent=base, fontName="Helvetica-Oblique", fontSize=11.5, leading=17,
                                    textColor=brand_color(BRAND_NAVY), alignment=0, spaceAfter=0),
    })
    # Cuerpo más cómodo de leer: alineado a la izquierda, sin justificar (evita «ríos» de espacio).
    styles["body"] = ParagraphStyle("WpBodyX", parent=base, alignment=0, fontSize=10.5, leading=16.5, spaceAfter=9)
    styles["subheading"] = ParagraphStyle(
        "WpSubheadingX", parent=styles["subheading"], fontSize=14, leading=18,
        textColor=brand_color(BRAND_NAVY), spaceBefore=16, spaceAfter=6,
    )
    return styles


class _ChapterTitle(Paragraph):
    """Título de capítulo que se registra en el índice."""

    def __init__(self, text: str, style: ParagraphStyle, toc_text: str, key: str):
        super().__init__(text, style)
        self.toc_text = toc_text
        self.toc_key = key


class _WhitepaperDoc(BaseDocTemplate):
    def __init__(self, buffer, *, title: str, language: str, cover_flowables_frame: Frame, body_frame: Frame):
        super().__init__(buffer, pagesize=LETTER, title=title, author=BRAND_NAME,
                         leftMargin=MARGIN_X, rightMargin=MARGIN_X, topMargin=70, bottomMargin=64)
        self._book_title = title
        self.addPageTemplates([
            PageTemplate(id="cover", frames=[cover_flowables_frame], onPage=_draw_cover_background),
            PageTemplate(id="body", frames=[body_frame], onPage=self._draw_running_header),
        ])

    def afterFlowable(self, flowable):
        if isinstance(flowable, _ChapterTitle):
            self.canv.bookmarkPage(flowable.toc_key)
            self.canv.addOutlineEntry(flowable.toc_text, flowable.toc_key, 0, 0)
            self.notify("TOCEntry", (0, flowable.toc_text, self.page, flowable.toc_key))

    def _draw_running_header(self, canv, _doc):
        canv.saveState()
        canv.setFont("Helvetica", 8)
        canv.setFillColor(brand_color(BRAND_MUTED))
        title = self._book_title if len(self._book_title) <= 80 else self._book_title[:77] + "…"
        canv.drawString(MARGIN_X, PAGE_H - 40, title)
        canv.setStrokeColor(brand_color(BRAND_BORDER))
        canv.setLineWidth(0.5)
        canv.line(MARGIN_X, PAGE_H - 46, PAGE_W - MARGIN_X, PAGE_H - 46)
        canv.restoreState()


def _draw_cover_background(canv, _doc):
    canv.saveState()
    canv.setFillColor(brand_color(BRAND_DEEP_NAVY))
    canv.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    # Franja lateral y bloque de color de marca
    canv.setFillColor(brand_color(ACCENT))
    canv.rect(0, 0, 14, PAGE_H, stroke=0, fill=1)
    canv.rect(MARGIN_X, PAGE_H - 250, 70, 5, stroke=0, fill=1)
    if brand.logo_available():  # el logo es blanco: va sobre el fondo de color
        from reportlab.lib.utils import ImageReader
        w, h = ImageReader(str(brand.LOGO_PATH)).getSize()
        logo_h = 38
        canv.drawImage(str(brand.LOGO_PATH), MARGIN_X, PAGE_H - 70 - logo_h, width=logo_h * w / h, height=logo_h, mask="auto")
    canv.restoreState()


def _numbered_canvas_factory(language: str):
    labels = _labels(language)

    class NumberedCanvas(rl_canvas.Canvas):
        """Canvas de dos pasadas para escribir «Página X de Y» en el pie."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_page_states: list[dict] = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_page_states)
            for state in self._saved_page_states:
                self.__dict__.update(state)
                if self._pageNumber > 1:  # la portada no lleva pie
                    self._draw_footer(total)
                super().showPage()
            super().save()

        def _draw_footer(self, total: int):
            self.saveState()
            self.setStrokeColor(brand_color(BRAND_BORDER))
            self.setLineWidth(0.5)
            self.line(MARGIN_X, 44, PAGE_W - MARGIN_X, 44)
            self.setFont("Helvetica-Bold", 8)
            self.setFillColor(brand_color(BRAND_PRIMARY_INDIGO))
            self.drawString(MARGIN_X, 30, BRAND_NAME)
            self.setFont("Helvetica", 8)
            self.setFillColor(brand_color(BRAND_MUTED))
            self.drawRightString(PAGE_W - MARGIN_X, 30, f"{labels['page']} {self._pageNumber} {labels['of']} {total}")
            self.restoreState()

    return NumberedCanvas


def _callout(tag, styles) -> list:
    text = tag.get_text(" ", strip=True)
    if text.startswith(">"):
        text = text.lstrip("> ").strip()
    if not text:
        return []
    box = Table([[Paragraph(escape(text), styles["wpCallout"])]], colWidths=[PAGE_W - 2 * MARGIN_X])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), brand_color(BRAND_SOFT_INDIGO_SURFACE)),
        ("LINEBEFORE", (0, 0), (0, -1), 3.5, brand_color(ACCENT)),
        ("LEFTPADDING", (0, 0), (-1, -1), 16),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 11),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
    ]))
    return [Spacer(1, 6), box, Spacer(1, 12)]


def _prepare_html(content: str) -> str:
    """Convierte a HTML y marca las citas (`blockquote` o líneas que empiezan con «>») como callouts."""
    if not content or not content.strip():
        return ""
    probe = BeautifulSoup(content, "html.parser")
    html = content if probe.find(["h1", "h2", "h3", "p", "ul", "ol", "div", "blockquote"]) else text_or_markdown_to_html(content)
    soup = BeautifulSoup(html, "html.parser")
    for node in soup.find_all(["blockquote", "p"]):
        if node.name == "p" and not node.get_text(strip=True).startswith(">"):
            continue
        text = node.get_text(" ", strip=True)
        replacement = soup.new_tag("div")
        replacement["class"] = ["wp-callout"]
        replacement.string = text
        node.replace_with(replacement)
    return str(soup)


def build_whitepaper_pdf(book: Dict[str, Any], chapters: List[Dict[str, Any]], language: str = "en") -> bytes:
    """``chapters`` ya debe venir con el contenido limpio (sin el encabezado duplicado)."""
    lang = normalize_language(language)
    labels = _labels(lang)
    styles = whitepaper_styles()
    title = (book.get("title") or "").strip() or "Whitepaper"
    subtitle = (book.get("description") or "").strip()

    cover_frame = Frame(MARGIN_X, 150, PAGE_W - 2 * MARGIN_X - 20, PAGE_H - 420, id="cover", showBoundary=0,
                        leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    body_frame = Frame(MARGIN_X, 64, PAGE_W - 2 * MARGIN_X, PAGE_H - 64 - 70, id="body", showBoundary=0,
                       leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)

    story: list = [
        Paragraph(f"{labels['whitepaper']}  ·  {BRAND_NAME.upper()}", styles["wpEyebrow"]),
        Paragraph(escape(title), styles["wpCoverTitle"]),
    ]
    if subtitle:
        story.append(Paragraph(escape(subtitle), styles["wpCoverSubtitle"]))
    story.append(Spacer(1, 22))
    story.append(Paragraph(escape(format_date(lang)), styles["wpEyebrow"]))
    story += [NextPageTemplate("body"), PageBreak()]

    if chapters:
        toc = TableOfContents()
        toc.levelStyles = [styles["wpToc"]]
        toc.dotsMinLevel = 0
        story.append(Paragraph(escape(labels["contents"]), styles["wpTocTitle"]))
        story.append(HRFlowable(width="100%", thickness=1.6, color=brand_color(ACCENT), spaceAfter=16, hAlign="LEFT"))
        story.append(toc)

    for i, ch in enumerate(chapters, start=1):
        story.append(PageBreak())
        ch_title = (ch.get("title") or "").strip()
        story.append(Paragraph(f"{labels['chapter']} {i}", styles["wpChapterLabel"]))
        story.append(_ChapterTitle(escape(ch_title), styles["wpChapterTitle"], f"{i}. {ch_title}", f"chapter-{i}"))
        story.append(HRFlowable(width="100%", thickness=1.6, color=brand_color(ACCENT), spaceAfter=14, hAlign="LEFT"))
        story.extend(html_to_flowables(_prepare_html(ch.get("content", "")), styles, class_renderers={"wp-callout": _callout}, accent_color=ACCENT))

    buffer = BytesIO()
    doc = _WhitepaperDoc(buffer, title=title, language=lang, cover_flowables_frame=cover_frame, body_frame=body_frame)
    doc.multiBuild(story, canvasmaker=_numbered_canvas_factory(lang))
    return buffer.getvalue()
