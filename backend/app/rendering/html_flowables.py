"""HTML-to-ReportLab helpers shared by generated document renderers."""
from __future__ import annotations

import re
from typing import Callable
from xml.sax.saxutils import escape

from bs4 import BeautifulSoup
from reportlab.lib import colors
from reportlab.platypus import ListFlowable, ListItem, Paragraph, Spacer

from app.rendering.brand_styles import BRAND_BODY_TEXT, BRAND_PRIMARY_INDIGO


def text_or_markdown_to_html(text: str) -> str:
    """Convert markdown or plain text with double-newlines into clean semantic HTML."""
    if not text or not text.strip():
        return ""

    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n{2,}", normalized)

    html_parts = []
    for block in blocks:
        block = block.strip()
        if not block:
            continue

        # Markdown headings (# Heading, ## Heading, ### Heading)
        m_head = re.match(r"^(#{1,6})\s+(.*)$", block, re.DOTALL)
        if m_head:
            level = len(m_head.group(1))
            heading_text = m_head.group(2).strip()
            tag = "h2" if level <= 2 else "h3"
            html_parts.append(f"<{tag}>{escape(heading_text)}</{tag}>")
            continue

        # Lists: unordered (- item, * item, • item)
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if all(re.match(r"^[-*•]\s+", line) for line in lines):
            items = []
            for line in lines:
                cleaned = re.sub(r"^[-*•]\s+", "", line)
                items.append(f"<li>{escape(cleaned)}</li>")
            html_parts.append(f"<ul>{''.join(items)}</ul>")
            continue

        # Lists: ordered (1. item, 2. item)
        if all(re.match(r"^\d+[\.\)]\s+", line) for line in lines):
            items = []
            for line in lines:
                cleaned = re.sub(r"^\d+[\.\)]\s+", "", line)
                items.append(f"<li>{escape(cleaned)}</li>")
            html_parts.append(f"<ol>{''.join(items)}</ol>")
            continue

        # Short standalone line without sentence-ending punctuation -> subheading (h3)
        if len(lines) == 1 and len(block) < 80 and not block.endswith((".", ":", ";", ",")):
            html_parts.append(f"<h3>{escape(block)}</h3>")
            continue

        # Regular paragraph: convert **bold** and *italic*
        p_text = escape(block)
        p_text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", p_text)
        p_text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", p_text)
        p_text = p_text.replace("\n", "<br/>")
        html_parts.append(f"<p>{p_text}</p>")

    return "\n".join(html_parts)


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
    """Convert semantic HTML or Markdown to flowables, with optional class-based render hooks."""
    story = []
    if not content_html or not content_html.strip():
        return story

    soup = BeautifulSoup(content_html, "html.parser")
    block_tags = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "div", "span", "blockquote", "table", "section", "article"]
    has_blocks = bool(soup.find(block_tags))

    if not has_blocks:
        content_html = text_or_markdown_to_html(content_html)
        soup = BeautifulSoup(content_html, "html.parser")

    container = soup.body if soup.body else soup
    children = [c for c in container.children if getattr(c, "name", None)]
    renderers = class_renderers or {}
    if len(children) == 1 and children[0].name in ("div", "section", "article"):
        child_classes = _class_names(children[0])
        if not any(cls in renderers for cls in child_classes):
            container = children[0]

    for node in container.children:
        if isinstance(node, str):
            text = node.strip()
            if text:
                story.append(Paragraph(escape(text), styles["body"]))
            continue

        if not getattr(node, "name", None):
            continue

        tag = node
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

        if tag.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            text = inline_markup(tag)
            if text:
                story.append(Paragraph(text, styles["subheading"]))
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
