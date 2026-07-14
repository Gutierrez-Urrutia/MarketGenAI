"""HTML-to-ReportLab helpers shared by generated document renderers."""
from __future__ import annotations

from typing import Callable
from xml.sax.saxutils import escape

from bs4 import BeautifulSoup
from reportlab.lib import colors
from reportlab.platypus import ListFlowable, ListItem, Paragraph, Spacer

from app.rendering.brand_styles import BRAND_BODY_TEXT, BRAND_PRIMARY_INDIGO


def inline_markup(tag) -> str:
    """Render children as ReportLab mini-HTML while preserving simple inline tags."""
    parts = []
    for node in tag.children:
        if isinstance(node, str):
            parts.append(escape(str(node)))
        elif node.name in ("strong", "b"):
            parts.append(f"<b>{inline_markup(node)}</b>")
        elif node.name in ("em", "i"):
            parts.append(f"<i>{inline_markup(node)}</i>")
        elif node.name == "code":
            parts.append(f'<font name="Courier" color="{BRAND_PRIMARY_INDIGO}">{inline_markup(node)}</font>')
        elif node.name == "br":
            parts.append("<br/>")
        else:
            parts.append(escape(node.get_text(" ", strip=True)))
    return "".join(parts).strip()


def _class_names(tag) -> set[str]:
    value = tag.get("class") or []
    if isinstance(value, str):
        value = value.split()
    return set(value)


def html_to_flowables(
    content_html: str,
    styles: dict,
    *,
    class_renderers: dict[str, Callable] | None = None,
) -> list:
    """Convert semantic HTML to flowables, with optional class-based render hooks."""
    story = []
    if not content_html:
        return story
    soup = BeautifulSoup(content_html, "html.parser")
    renderers = class_renderers or {}

    for tag in soup.find_all(["h1", "h2", "h3", "p", "ul", "ol", "div", "span", "blockquote"], recursive=False):
        handled = False
        for class_name in _class_names(tag):
            renderer = renderers.get(class_name)
            if renderer:
                rendered = renderer(tag, styles)
                if rendered:
                    story.extend(rendered)
                handled = True
                break
        if handled:
            continue

        if tag.name in ("h1", "h2", "h3"):
            story.append(Paragraph(inline_markup(tag), styles["subheading"]))
        elif tag.name in ("p", "span", "div"):
            text = inline_markup(tag)
            if text:
                story.append(Paragraph(text, styles["body"]))
        elif tag.name == "blockquote":
            text = inline_markup(tag)
            if text:
                story.append(Paragraph(text, styles.get("blockquote", styles["body"])))
        elif tag.name == "ul":
            items = [inline_markup(li) for li in tag.find_all("li") if li.get_text(strip=True)]
            if items:
                story.append(ListFlowable(
                    [ListItem(Paragraph(item, styles["body"]), leftIndent=6) for item in items],
                    bulletType="bullet",
                    start="circle",
                    leftIndent=16,
                    bulletFontSize=7,
                    bulletColor=colors.HexColor(BRAND_PRIMARY_INDIGO),
                ))
                story.append(Spacer(1, 6))
        elif tag.name == "ol":
            items = [inline_markup(li) for li in tag.find_all("li") if li.get_text(strip=True)]
            if items:
                story.append(ListFlowable(
                    [ListItem(Paragraph(item, styles["body"])) for item in items],
                    bulletType="1",
                    leftIndent=16,
                    bulletFontSize=9,
                    bulletColor=colors.HexColor(BRAND_BODY_TEXT),
                ))
                story.append(Spacer(1, 6))
    return story
