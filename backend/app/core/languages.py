"""Idiomas de la aplicación y utilidades para pedírselos al modelo con claridad.

El modelo de lenguaje ignora a menudo una instrucción como «Language: es» (un código de dos letras),
sobre todo si el resto del prompt está en inglés. Hay que nombrar el idioma completo.
"""
from __future__ import annotations

import re
from typing import Optional

# Nombre en inglés (lo que mejor entiende el modelo) y, entre paréntesis, en el propio idioma.
LANGUAGE_NAMES = {
    "es": "Spanish (español)",
    "en": "English",
    "pt": "Portuguese (português)",
}
DEFAULT_LANGUAGE = "en"


def normalize_language(code: Optional[str]) -> str:
    """'es', 'ES', 'es-CL' o ' es ' -> 'es'. Un código desconocido se devuelve tal cual (en minúsculas)."""
    value = (code or "").strip().lower().replace("_", "-")
    return value.split("-")[0] if value else DEFAULT_LANGUAGE


def language_name(code: Optional[str]) -> str:
    """Nombre completo para el prompt. Si el código no es uno de los tres, se usa el código tal cual."""
    normalized = normalize_language(code)
    return LANGUAGE_NAMES.get(normalized, normalized)


# Palabras muy frecuentes y que NO se comparten entre idiomas, para detectar en qué idioma está un texto.
_MARKERS = {
    "en": {"the", "and", "of", "to", "is", "are", "with", "that", "your", "this", "from", "which", "can", "will", "has"},
    "es": {"el", "los", "las", "del", "y", "un", "es", "su", "sus", "al", "lo", "se", "como", "pero", "más", "también", "esta", "este"},
    "pt": {"os", "as", "do", "da", "dos", "das", "não", "em", "um", "ao", "é", "seu", "sua", "mais", "também", "está", "este", "essa"},
}
_WORD = re.compile(r"[a-záéíóúñçãõâêôà]+", re.IGNORECASE)
MIN_WORDS_TO_JUDGE = 40


def detect_language(text: str) -> Optional[str]:
    """Idioma dominante entre en/es/pt, o None si el texto es muy corto o no hay una señal clara."""
    words = [w.lower() for w in _WORD.findall(text or "")]
    if len(words) < MIN_WORDS_TO_JUDGE:
        return None
    scores = {lang: sum(1 for w in words if w in markers) for lang, markers in _MARKERS.items()}
    best = max(scores, key=scores.get)
    ordered = sorted(scores.values(), reverse=True)
    if ordered[0] < 5 or ordered[0] < ordered[1] * 1.5:
        return None
    return best


def is_wrong_language(text: str, expected: Optional[str]) -> bool:
    """True si el texto está claramente en uno de los idiomas soportados y no es el esperado."""
    expected_code = normalize_language(expected)
    if expected_code not in _MARKERS:
        return False
    detected = detect_language(text)
    return detected is not None and detected != expected_code
