"""Whitepaper profesional: portada, índice, capítulos en página nueva, callouts y pie «Página X de Y»."""
import re
from datetime import datetime
from io import BytesIO

from pypdf import PdfReader

from app.rendering import whitepaper
from app.workers.tasks import asset_tasks

PARA = ("La inteligencia artificial está cambiando la forma en que los equipos planifican, producen y miden sus "
        "campañas. ") * 6

BOOK = {"title": "Guía de marketing con IA", "description": "Cómo planificar y medir campañas."}
CHAPTERS = [
    {"title": "Fundamentos", "content": f"## Por qué importa\n\n{PARA}\n\n> Idea clave: la IA acelera la estrategia.\n\n{PARA}"},
    {"title": "Flujos prácticos", "content": f"<h2>Flujos</h2><p>{PARA}</p><blockquote>Un buen proceso vale más.</blockquote>"},
    {"title": "Medición", "content": PARA * 3},
]


def _pages(pdf_bytes: bytes) -> list[str]:
    return [page.extract_text() or "" for page in PdfReader(BytesIO(pdf_bytes)).pages]


def test_whitepaper_has_cover_toc_and_chapters_in_spanish():
    pages = _pages(asset_tasks._build_whitepaper_pdf(BOOK, CHAPTERS, "es"))
    assert "Guía de marketing con IA" in pages[0]
    assert "WHITEPAPER" in pages[0]
    assert "Contenido" in pages[1]
    for title in ("Fundamentos", "Flujos prácticos", "Medición"):
        assert title in pages[1]  # entra en el índice
    assert any("CAPÍTULO 1" in p and "Fundamentos" in p for p in pages)
    assert any("CAPÍTULO 3" in p for p in pages)


def test_each_chapter_starts_on_a_new_page():
    pages = _pages(asset_tasks._build_whitepaper_pdf(BOOK, CHAPTERS, "es"))
    starts = [i for i, text in enumerate(pages) if "CAPÍTULO" in text]
    assert len(starts) == 3 and len(set(starts)) == 3


def test_footer_shows_page_x_of_total_in_each_language():
    es = _pages(asset_tasks._build_whitepaper_pdf(BOOK, CHAPTERS, "es"))
    total = len(es)
    assert f"Página 2 de {total}" in es[1]
    assert "Página 1" not in es[0]  # la portada no lleva pie
    en = _pages(asset_tasks._build_whitepaper_pdf(BOOK, CHAPTERS, "en"))
    assert f"Page 2 of {len(en)}" in en[1]
    assert "CHAPTER 1" in "\n".join(en) and "Contents" in en[1]


def test_toc_page_numbers_point_to_the_right_pages():
    pages = _pages(asset_tasks._build_whitepaper_pdf(BOOK, CHAPTERS, "es"))
    numbers = [int(m) for m in re.findall(r"(?:\.\s+)+(\d+)\s*$", pages[1], flags=re.M)]
    assert len(numbers) == 3
    for chapter_n, page_number in enumerate(numbers, start=1):
        assert f"CAPÍTULO {chapter_n}" in pages[page_number - 1]


def test_callout_markdown_and_blockquote_become_wp_callout():
    html = whitepaper._prepare_html("Texto normal.\n\n> Idea clave: acelerar.")
    assert 'class="wp-callout"' in html and "Idea clave: acelerar." in html
    assert 'class="wp-callout"' in whitepaper._prepare_html("<p>a</p><blockquote>cita</blockquote>")
    assert "wp-callout" not in whitepaper._prepare_html("Solo un párrafo.")


def test_whitepaper_without_chapters_still_builds_a_cover():
    pages = _pages(asset_tasks._build_whitepaper_pdf(BOOK, [], "es"))
    assert len(pages) >= 1 and "Guía de marketing con IA" in pages[0]


def test_format_date_is_localized():
    when = datetime(2026, 11, 17)
    assert whitepaper.format_date("es", when) == "17 de noviembre de 2026"
    assert whitepaper.format_date("en", when) == "November 17, 2026"
    assert whitepaper.format_date("pt", when) == "17 de novembro de 2026"
    assert whitepaper.format_date("xx", when) == "November 17, 2026"
