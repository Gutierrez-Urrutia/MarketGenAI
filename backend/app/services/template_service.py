"""Plantillas de propuesta (RF-VTA-07): catálogo de clasificación, variables estándar,
condiciones comerciales base y reemplazo de {variables}. Todo puro, sin Firestore."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from app.schemas.template import Industry, ServiceType, TemplateType

LANGUAGES = ("es", "en", "pt")

SERVICE_TYPE_LABELS: Dict[str, Dict[str, str]] = {
    ServiceType.customer_service.value:   {"es": "Atención al cliente", "en": "Customer service", "pt": "Atendimento ao cliente"},
    ServiceType.back_office.value:        {"es": "Back office", "en": "Back office", "pt": "Back office"},
    ServiceType.collections.value:        {"es": "Cobranza", "en": "Collections", "pt": "Cobrança"},
    ServiceType.finance_accounting.value: {"es": "Finanzas y contabilidad", "en": "Finance and accounting", "pt": "Finanças e contabilidade"},
    ServiceType.payroll.value:            {"es": "Remuneraciones", "en": "Payroll", "pt": "Folha de pagamento"},
    ServiceType.data_entry.value:         {"es": "Ingreso de datos", "en": "Data entry", "pt": "Entrada de dados"},
    ServiceType.virtual_assistant.value:  {"es": "Asistencia virtual", "en": "Virtual assistance", "pt": "Assistência virtual"},
    ServiceType.lead_generation.value:    {"es": "Generación de leads", "en": "Lead generation", "pt": "Geração de leads"},
    ServiceType.other.value:              {"es": "Otro", "en": "Other", "pt": "Outro"},
}

INDUSTRY_LABELS: Dict[str, Dict[str, str]] = {
    Industry.general.value:            {"es": "General", "en": "General", "pt": "Geral"},
    Industry.financial_services.value: {"es": "Servicios financieros", "en": "Financial services", "pt": "Serviços financeiros"},
    Industry.healthcare.value:         {"es": "Salud", "en": "Healthcare", "pt": "Saúde"},
    Industry.retail_ecommerce.value:   {"es": "Retail y e-commerce", "en": "Retail and e-commerce", "pt": "Varejo e e-commerce"},
    Industry.telecom.value:            {"es": "Telecomunicaciones", "en": "Telecommunications", "pt": "Telecomunicações"},
    Industry.technology.value:         {"es": "Tecnología", "en": "Technology", "pt": "Tecnologia"},
    Industry.manufacturing.value:      {"es": "Manufactura", "en": "Manufacturing", "pt": "Manufatura"},
    Industry.logistics.value:          {"es": "Logística y transporte", "en": "Logistics and transportation", "pt": "Logística e transporte"},
    Industry.education.value:          {"es": "Educación", "en": "Education", "pt": "Educação"},
    Industry.public_sector.value:      {"es": "Sector público", "en": "Public sector", "pt": "Setor público"},
}

# Variables que el backend completa al aplicar, agrupadas por origen. Las descripciones
# visibles van en el i18n del frontend.
STANDARD_VARIABLES: Dict[str, List[str]] = {
    "customer": ["cliente_nombre", "cliente_empresa", "cliente_email"],
    "proposal": [
        "propuesta_titulo", "servicio", "industria", "monto_total",
        "fecha", "valida_hasta", "referencia", "preparado_por",
    ],
}

DEFAULT_COMMERCIAL_TERMS: Dict[str, str] = {
    "es": (
        "Vigencia de la oferta: esta propuesta es válida hasta el {valida_hasta}.\n"
        "Valor total: {monto_total}, según el detalle de la tabla de precios. Los valores no incluyen impuestos.\n"
        "Forma de pago: facturación mensual, con pago a 30 días desde la emisión de cada factura.\n"
        "Reajuste: los precios se reajustan una vez al año según el índice que acuerden las partes.\n"
        "Inicio del servicio: sujeto a la aceptación de esta propuesta y a la firma del contrato de prestación de servicios."
    ),
    "en": (
        "Offer validity: this proposal is valid until {valida_hasta}.\n"
        "Total value: {monto_total}, as detailed in the pricing table. Prices exclude taxes.\n"
        "Payment terms: monthly invoicing, payable within 30 days of each invoice date.\n"
        "Price adjustment: prices are adjusted once a year according to the index agreed by both parties.\n"
        "Service start: subject to acceptance of this proposal and signature of the services agreement."
    ),
    "pt": (
        "Validade da oferta: esta proposta é válida até {valida_hasta}.\n"
        "Valor total: {monto_total}, conforme o detalhamento da tabela de preços. Os valores não incluem impostos.\n"
        "Forma de pagamento: faturamento mensal, com pagamento em até 30 dias a partir da emissão de cada fatura.\n"
        "Reajuste: os preços são reajustados uma vez por ano conforme o índice acordado entre as partes.\n"
        "Início do serviço: sujeito à aceitação desta proposta e à assinatura do contrato de prestação de serviços."
    ),
}

# {variable} y también {{variable}}, que es lo que guardaba el editor de Settings antes
# de RF-VTA-07: sin esto, {{x}} quedaría como {valor}.
_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_]\w*)\s*\}\}|\{([A-Za-z_]\w*)\}")


def lang_code(language: Optional[str]) -> str:
    code = (language or "es").strip().lower()[:2]
    return code if code in LANGUAGES else "es"


def default_commercial_terms(language: Optional[str] = None) -> str:
    return DEFAULT_COMMERCIAL_TERMS[lang_code(language)]


def catalog() -> Dict[str, Any]:
    return {
        "serviceTypes": [{"value": code, "labels": labels} for code, labels in SERVICE_TYPE_LABELS.items()],
        "industries": [{"value": code, "labels": labels} for code, labels in INDUSTRY_LABELS.items()],
        "standardVariables": STANDARD_VARIABLES,
        "defaultCommercialTerms": DEFAULT_COMMERCIAL_TERMS,
    }


def with_defaults(template: Dict[str, Any]) -> Dict[str, Any]:
    """Completa en memoria lo que no traen las plantillas guardadas antes de RF-VTA-07:
    clasificación por defecto y, en plantillas de propuesta, el bloque de condiciones
    comerciales. No escribe en Firestore."""
    filled = {**template}
    filled["serviceType"] = filled.get("serviceType") or ServiceType.other.value
    filled["industry"] = filled.get("industry") or Industry.general.value
    if filled.get("type") == TemplateType.proposal.value and not (filled.get("commercialTerms") or "").strip():
        filled["commercialTerms"] = default_commercial_terms()
    return filled


def render_placeholders(text: Optional[str], values: Dict[str, Any]) -> Tuple[Optional[str], List[str]]:
    """Reemplaza {variable} / {{variable}} con `values`. Lo que no tiene valor queda
    tal cual en el texto y se devuelve en la lista de faltantes (en orden de aparición)."""
    if text is None:
        return None, []
    missing: List[str] = []

    def _sub(match: re.Match) -> str:
        name = match.group(1) or match.group(2)
        value = values.get(name)
        if value is None or str(value).strip() == "":
            if name not in missing:
                missing.append(name)
            return match.group(0)
        return str(value)

    return _PLACEHOLDER.sub(_sub, text), missing


def classification_labels(service_type: Optional[str], industry: Optional[str], language: Optional[str]) -> Dict[str, Optional[str]]:
    lang = lang_code(language)
    return {
        "servicio": SERVICE_TYPE_LABELS.get(service_type or "", {}).get(lang),
        "industria": INDUSTRY_LABELS.get(industry or "", {}).get(lang),
    }
