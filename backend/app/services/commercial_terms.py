"""Condiciones comerciales de una propuesta (RNF-03).

El bloque de condiciones comerciales de la plantilla se inyecta como lista en la sección «Precios y
Condiciones Comerciales» (proposal_tasks.inject_commercial_terms). Al editar una propuesta ya generada
se puede borrar: este módulo detecta esa pérdida para que la API la advierta (el guardado sigue).
"""
import unicodedata
from typing import Optional

from bs4 import BeautifulSoup

WARNING_COMMERCIAL_TERMS_MISSING = "commercial_terms_missing"

# Mismos encabezados que SECTION_HEADINGS (workers/tasks/proposal_tasks.py), sin acentos y en minúscula.
_COMMERCIAL_HEADINGS = frozenset({
    "precios y condiciones comerciales",
    "pricing and commercial terms",
    "precos e condicoes comerciais",
})


def _normalize(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c)).strip().lower()


def has_commercial_terms(html: Optional[str]) -> Optional[bool]:
    """True/False si la propuesta trae condiciones comerciales; None si no tiene la sección de
    precios y condiciones (formato libre o antiguo: no se puede opinar).

    Cuenta cualquier ítem de lista o párrafo con texto dentro de la sección, sin contar la tabla de
    precios ni la tarjeta del total."""
    if not html or not html.strip():
        return None
    soup = BeautifulSoup(html, "html.parser")
    heading = next((h for h in soup.find_all("h2") if _normalize(h.get_text()) in _COMMERCIAL_HEADINGS), None)
    if heading is None:
        return None
    if heading.parent is not None and heading.parent.name == "section":
        container = BeautifulSoup(str(heading.parent), "html.parser")
        container_h2 = container.find("h2")
        if container_h2 is not None:
            container_h2.decompose()
    else:
        container = BeautifulSoup("", "html.parser")
        for sibling in heading.next_siblings:
            if getattr(sibling, "name", None) == "h2":
                break
            container.append(BeautifulSoup(str(sibling), "html.parser"))
    for node in container.select("table, .proposal-total-card"):
        node.decompose()
    return any(node.get_text(strip=True) for node in container.find_all(["li", "p"]))


def loses_commercial_terms(previous_html: Optional[str], new_html: Optional[str]) -> bool:
    """Guardar `new_html` dejaría sin condiciones comerciales una propuesta que sí las tenía."""
    return has_commercial_terms(previous_html) is True and has_commercial_terms(new_html) is not True
