"""Mensajes de error seguros para el usuario (RNF-04).

Una falla de un servicio externo (IA, CRM, base de datos) se informa con un texto fijo y claro; el detalle real (cuerpo del
proveedor, claves parciales, hosts, rutas del servidor) va solo al log y nunca a la respuesta, al job ni al registro de auditoría.
"""
from __future__ import annotations

import logging
from typing import Tuple

import httpx
from fastapi import HTTPException
from google.api_core import exceptions as google_exceptions
from openai import OpenAIError

from app.services.crm_service import CrmAuthError, CrmProviderError, CrmTimeoutError
from app.services.deepseek_service import LLMTimeoutError

logger = logging.getLogger("marketgen.errors")

LLM_UNAVAILABLE = "El servicio de IA no está disponible en este momento. Inténtalo de nuevo en unos minutos."
LLM_TIMEOUT = "El servicio de IA tardó demasiado en responder. Inténtalo de nuevo."
DB_UNAVAILABLE = "La base de datos no está disponible en este momento. Inténtalo de nuevo en unos minutos."
DB_QUOTA = "Se alcanzó el límite de uso de la base de datos. Inténtalo de nuevo más tarde."
CRM_AUTH = "El CRM rechazó la credencial. Revisa la conexión en Configuración."
CRM_TIMEOUT = "El CRM tardó demasiado en responder. Inténtalo de nuevo."
CRM_PROVIDER = "El CRM respondió con un error. Inténtalo de nuevo en unos minutos."
CRM_UNREACHABLE = "No se pudo conectar con el CRM. Inténtalo de nuevo en unos minutos."
GENERIC = "No se pudo completar la operación. Inténtalo de nuevo."


def safe_error(exc: BaseException) -> Tuple[str, str]:
    """(código, mensaje fijo en español) para una excepción; el detalle real se escribe en el log."""
    if isinstance(exc, LLMTimeoutError):
        return "llm_timeout", LLM_TIMEOUT
    if isinstance(exc, OpenAIError):
        return "llm_unavailable", LLM_UNAVAILABLE
    # Los mensajes de CrmError los escribe crm_service y nombran al proveedor («API key inválida o sin permisos», «Timeout al conectar con
    # HubSpot», «HubSpot respondió con error 500»); el cuerpo que devolvió el proveedor ya no viaja en ellos, va solo al log.
    if isinstance(exc, CrmAuthError):
        return "crm_auth", str(exc) or CRM_AUTH
    if isinstance(exc, CrmTimeoutError):
        return "crm_timeout", str(exc) or CRM_TIMEOUT
    if isinstance(exc, CrmProviderError):
        return "crm_provider", str(exc) or CRM_PROVIDER
    if isinstance(exc, httpx.TimeoutException):
        return "timeout", CRM_TIMEOUT
    if isinstance(exc, httpx.HTTPError):
        return "unreachable", CRM_UNREACHABLE
    if isinstance(exc, google_exceptions.ResourceExhausted):
        return "db_quota", DB_QUOTA
    if isinstance(exc, (google_exceptions.GoogleAPICallError, google_exceptions.RetryError)):
        return "db_unavailable", DB_UNAVAILABLE
    if isinstance(exc, HTTPException) and 400 <= exc.status_code < 500 and isinstance(exc.detail, str):
        return "client_error", exc.detail   # error de negocio ya escrito para el usuario (p. ej. «el libro no tiene capítulos»)
    return "internal_error", GENERIC


def safe_error_message(exc: BaseException) -> str:
    """Mensaje seguro para guardar en un job o mostrar al usuario; el detalle real queda en el log."""
    code, message = safe_error(exc)
    logger.error("Detalle interno de la falla (%s): %r", code, exc)
    return message
