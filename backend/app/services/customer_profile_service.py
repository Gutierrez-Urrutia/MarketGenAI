"""Perfil del cliente (RF-VTA-03): industria y tamaño.

La industria reutiliza la lista de RF-VTA-07 (`Industry` / `INDUSTRY_LABELS`) para que clientes y
plantillas clasifiquen igual. El tamaño es una lista fija propia. Todo puro, sin Firestore.
"""
from __future__ import annotations

import unicodedata
from enum import Enum
from typing import Any, Dict, List, Optional

from app.schemas.template import Industry
from app.services.template_service import INDUSTRY_LABELS, LANGUAGES, lang_code


class CompanySize(str, Enum):
    """Tamaño del cliente por número de empleados. Rangos provisorios (RF-VTA-03, DR-02)."""
    micro  = "micro"
    small  = "small"
    medium = "medium"
    large  = "large"


SIZE_LABELS: Dict[str, Dict[str, str]] = {
    CompanySize.micro.value:  {"es": "Micro", "en": "Micro", "pt": "Micro"},
    CompanySize.small.value:  {"es": "Pequeña", "en": "Small", "pt": "Pequena"},
    CompanySize.medium.value: {"es": "Mediana", "en": "Medium", "pt": "Média"},
    CompanySize.large.value:  {"es": "Grande", "en": "Large", "pt": "Grande"},
}

SIZE_RANGES: Dict[str, str] = {
    CompanySize.micro.value:  "1-9",
    CompanySize.small.value:  "10-49",
    CompanySize.medium.value: "50-199",
    CompanySize.large.value:  "200+",
}

INDUSTRY_CODES: List[str] = [i.value for i in Industry]
SIZE_CODES: List[str] = [s.value for s in CompanySize]


def _norm(value: str) -> str:
    """Minúsculas y sin acentos: «Salud», «salud» y «SALUD» son lo mismo."""
    text = unicodedata.normalize("NFKD", value.strip().casefold())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def _build_index(labels: Dict[str, Dict[str, str]]) -> Dict[str, str]:
    index: Dict[str, str] = {}
    for code, per_lang in labels.items():
        index[_norm(code)] = code
        for label in per_lang.values():
            index.setdefault(_norm(label), code)
    return index


_INDUSTRY_INDEX = _build_index(INDUSTRY_LABELS)
_SIZE_INDEX = _build_index(SIZE_LABELS)


def _parse(value: Any, field: str, index: Dict[str, str], codes: List[str], allow_labels: bool) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, Enum):
        value = value.value
    if not isinstance(value, str):
        raise ValueError(f"{field} must be one of: {', '.join(codes)}.")
    text = value.strip()
    if not text:
        return None  # cadena vacía = sin dato (RN-04)
    code = index.get(_norm(text))
    if code is not None and (allow_labels or _norm(text) == _norm(code)):
        return code
    raise ValueError(f"{field} must be one of: {', '.join(codes)}.")


def parse_industry(value: Any, allow_labels: bool = False) -> Optional[str]:
    """Código de industria o None. `allow_labels` acepta también las etiquetas es/en/pt (CSV)."""
    return _parse(value, "industry", _INDUSTRY_INDEX, INDUSTRY_CODES, allow_labels)


def parse_size(value: Any, allow_labels: bool = False) -> Optional[str]:
    """Código de tamaño o None. `allow_labels` acepta también las etiquetas es/en/pt (CSV)."""
    return _parse(value, "size", _SIZE_INDEX, SIZE_CODES, allow_labels)


def industry_label(code: Optional[str], language: Optional[str]) -> Optional[str]:
    return INDUSTRY_LABELS.get(code or "", {}).get(lang_code(language))


def size_label(code: Optional[str], language: Optional[str]) -> Optional[str]:
    return SIZE_LABELS.get(code or "", {}).get(lang_code(language))


def profile_options() -> Dict[str, Any]:
    """Listas para los selectores de la pantalla."""
    return {
        "industries": [{"value": code, "labels": labels} for code, labels in INDUSTRY_LABELS.items()],
        "sizes": [
            {"value": code, "labels": labels, "employees": SIZE_RANGES[code]}
            for code, labels in SIZE_LABELS.items()
        ],
        "languages": list(LANGUAGES),
    }
