"""Single source of truth for branded document rendering colors."""
from __future__ import annotations

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet

BRAND_PRIMARY_INDIGO = "#4f46e5"
BRAND_DEEP_NAVY = "#111c30"
BRAND_NAVY = "#1a2b4a"
BRAND_SOFT_INDIGO_SURFACE = "#eef2ff"
BRAND_TEXT = "#1f2937"
BRAND_BODY_TEXT = "#334155"
BRAND_MUTED = "#64748b"
BRAND_BORDER = "#d8dee8"
BRAND_SURFACE = "#f6f8fb"


def brand_color(hex_value: str):
    return colors.HexColor(hex_value)


def content_base_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "coverTitle": ParagraphStyle("WpCoverTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=28, leading=34, textColor=brand_color(BRAND_PRIMARY_INDIGO), alignment=1, spaceAfter=14),
        "coverSubtitle": ParagraphStyle("WpCoverSubtitle", parent=base["Normal"], fontSize=12.5, leading=18, textColor=brand_color(BRAND_MUTED), alignment=1),
        "chapterTitle": ParagraphStyle("WpChapterTitle", parent=base["Heading1"], fontName="Helvetica-Bold", fontSize=18, leading=22, textColor=brand_color(BRAND_PRIMARY_INDIGO), spaceAfter=10),
        "subheading": ParagraphStyle("WpSubheading", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=13, leading=17, textColor=brand_color(BRAND_BODY_TEXT), spaceBefore=12, spaceAfter=6),
        "body": ParagraphStyle("WpBody", parent=base["BodyText"], fontName="Helvetica", fontSize=10.5, leading=16, textColor=brand_color(BRAND_TEXT), spaceAfter=8, alignment=4),
    }
