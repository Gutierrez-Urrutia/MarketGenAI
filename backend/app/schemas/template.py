"""Pydantic schemas for the Templates module."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


class TemplateType(str, Enum):
    book_concept = "book_concept"
    chapter      = "chapter"
    proposal     = "proposal"
    social_post  = "social_post"
    one_pager    = "one_pager"


class ServiceType(str, Enum):
    """Línea de servicio BPO de la plantilla (RF-VTA-07). Las etiquetas visibles
    viven en app/services/template_service.py."""
    customer_service   = "customer_service"
    back_office        = "back_office"
    collections        = "collections"
    finance_accounting = "finance_accounting"
    payroll            = "payroll"
    data_entry         = "data_entry"
    virtual_assistant  = "virtual_assistant"
    lead_generation    = "lead_generation"
    other              = "other"


class Industry(str, Enum):
    """Industria a la que apunta la plantilla (RF-VTA-07)."""
    general            = "general"
    financial_services = "financial_services"
    healthcare         = "healthcare"
    retail_ecommerce   = "retail_ecommerce"
    telecom            = "telecom"
    technology         = "technology"
    manufacturing      = "manufacturing"
    logistics          = "logistics"
    education          = "education"
    public_sector      = "public_sector"


class TemplateCreate(BaseModel):
    name:        str = Field(..., min_length=2, max_length=200)
    type:        TemplateType
    description: Optional[str] = None
    content:     str           # The template body (may contain {placeholders})
    variables:   List[str] = []   # e.g. ["client_name", "product"]
    isPublic:    bool = False
    serviceType: ServiceType = ServiceType.other
    industry:    Industry = Industry.general
    # Bloque de condiciones comerciales; en plantillas de propuesta, si llega vacío
    # se guarda el texto base (RF-VTA-07). Admite {variables}.
    commercialTerms: Optional[str] = None


class TemplateUpdate(BaseModel):
    name:        Optional[str] = Field(None, min_length=2, max_length=200)
    description: Optional[str] = None
    content:     Optional[str] = None
    variables:   Optional[List[str]] = None
    isPublic:    Optional[bool] = None
    serviceType: Optional[ServiceType] = None
    industry:    Optional[Industry] = None
    commercialTerms: Optional[str] = None


class TemplateOut(BaseModel):
    id:          str
    name:        str
    type:        str
    description: Optional[str] = None
    content:     str
    variables:   List[str] = []
    isPublic:    bool = False
    serviceType: str = ServiceType.other.value
    industry:    str = Industry.general.value
    commercialTerms: Optional[str] = None
    userId:      str
    usageCount:  int
    createdAt:   Optional[datetime] = None
    updatedAt:   Optional[datetime] = None

    class Config:
        from_attributes = True


class TemplateListResponse(BaseModel):
    items: List[TemplateOut]
    total: int


class ApplyTemplateRequest(BaseModel):
    """Valores manuales en `variables`; con `proposalId` y/o `customerId` el backend
    completa las variables estándar desde esos documentos. Los valores manuales
    tienen prioridad sobre los automáticos."""
    variables:  Dict[str, Any] = {}
    proposalId: Optional[str] = None
    customerId: Optional[str] = None
    language:   Optional[str] = None


class ApplyTemplateResponse(BaseModel):
    templateId:       str
    rendered:         str
    commercialTerms:  Optional[str] = None
    serviceType:      str
    industry:         str
    missingVariables: List[str] = []
