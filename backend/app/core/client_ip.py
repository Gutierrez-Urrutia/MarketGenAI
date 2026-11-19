"""IP del cliente para la auditoría (RNF-02)."""
from typing import Optional

from starlette.requests import Request

from app.config import settings


def get_client_ip(request: Request) -> Optional[str]:
    """IP real del cliente.

    Detrás de un proxy/PaaS `request.client.host` es la IP del proxy. Solo si
    `trust_proxy_headers` está activo se usa el primer valor de `X-Forwarded-For`
    (cualquiera puede enviar esa cabecera, por eso no se confía por defecto).
    """
    if settings.trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for", "")
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else None
