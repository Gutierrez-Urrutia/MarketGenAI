"""
Marca de NoonDalton para la exportación de propuestas (PDF y DOCX generados en el servidor).

Refleja frontend/src/config/brand.js: si cambian el color o el logo allá, hay que cambiarlos aquí y
reemplazar app/assets/brand/logo.png (copia de frontend/public/brand/logo.png).
El logo es blanco sobre fondo transparente: siempre se coloca sobre la banda de color primario.
"""
from __future__ import annotations

from pathlib import Path

NAME = "NoonDalton"
LOGO_PATH = Path(__file__).resolve().parent.parent / "assets" / "brand" / "logo.png"

PRIMARY = "#225258"   # títulos, tablas, bandas y logo
ACCENT = "#FF5500"    # solo bordes, líneas y etiquetas; nunca texto pequeño sobre blanco

TEXT = "#1F2937"
MUTED = "#5E6B7E"
BORDER = "#D8DEE8"
SURFACE = "#F6F8FB"
WHITE = "#FFFFFF"


def _mix(hex_a: str, hex_b: str, amount: float) -> str:
    """Mezcla hex_a con hex_b; `amount` es la proporción de hex_b (0..1)."""
    a = [int(hex_a.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)]
    b = [int(hex_b.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)]
    return "#" + "".join(f"{round(x * (1 - amount) + y * amount):02X}" for x, y in zip(a, b))


PRIMARY_DEEP = _mix(PRIMARY, "#000000", 0.3)
PRIMARY_SOFT = _mix(PRIMARY, WHITE, 0.9)
PRIMARY_TINT = _mix(PRIMARY, WHITE, 0.95)


def logo_available() -> bool:
    return LOGO_PATH.is_file()
