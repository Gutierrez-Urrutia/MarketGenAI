"""Pydantic schemas for the Proposals module."""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Dict, FrozenSet, List, Literal, Optional, Union

from pydantic import AliasChoices, BaseModel, ConfigDict, EmailStr, Field


class ProposalStatus(str, Enum):
    """Estado comercial de la propuesta (campo `proposal_status`, RF-VTA-05).

    Se guarda como código; las etiquetas visibles salen del i18n del frontend.
    No confundir con `status`, que es el ciclo de generación con IA."""
    borrador       = "borrador"
    enviada        = "enviada"
    vista          = "vista"
    en_negociacion = "en_negociacion"
    firmada        = "firmada"
    rechazada      = "rechazada"


PROPOSAL_STATUS_VALUES: FrozenSet[str] = frozenset(s.value for s in ProposalStatus)

# Transiciones permitidas. Todo lo que no está aquí es inválido, incluido
# misma→misma. rechazada→en_negociacion (reapertura) además exige ser admin.
PROPOSAL_STATUS_TRANSITIONS: Dict[ProposalStatus, FrozenSet[ProposalStatus]] = {
    ProposalStatus.borrador:       frozenset({ProposalStatus.enviada}),
    ProposalStatus.enviada:        frozenset({ProposalStatus.vista, ProposalStatus.en_negociacion, ProposalStatus.rechazada}),
    ProposalStatus.vista:          frozenset({ProposalStatus.en_negociacion, ProposalStatus.rechazada}),
    ProposalStatus.en_negociacion: frozenset({ProposalStatus.firmada, ProposalStatus.rechazada}),
    ProposalStatus.firmada:        frozenset(),
    ProposalStatus.rechazada:      frozenset({ProposalStatus.en_negociacion}),
}

ADMIN_ONLY_TRANSITIONS: FrozenSet[tuple] = frozenset({
    (ProposalStatus.rechazada, ProposalStatus.en_negociacion),
})


def _fold(value: str) -> str:
    """Minúsculas, sin tildes ni espacios sobrantes: "En Negociación " → "en negociacion"."""
    decomposed = unicodedata.normalize("NFKD", value)
    return " ".join("".join(c for c in decomposed if not unicodedata.combining(c)).lower().split())


# Valores que se guardaban antes de RF-VTA-05, comparados ya plegados con _fold.
LEGACY_PROPOSAL_STATUS: Dict[str, ProposalStatus] = {
    "generada":       ProposalStatus.borrador,
    "entregada":      ProposalStatus.enviada,
    "en negociacion": ProposalStatus.en_negociacion,
    "cerrada":        ProposalStatus.firmada,
    "en contrato":    ProposalStatus.firmada,
    "perdida":        ProposalStatus.rechazada,
}


def normalize_proposal_status(value: Any) -> Any:
    """Pura. Lleva un `proposal_status` guardado a su código actual.

    - Código actual → igual.
    - Valor viejo (sin importar mayúsculas ni tildes) → su código.
    - Ausente (None) → borrador.
    - Cualquier otro valor → se devuelve tal cual; quien llama decide si avisa
      (no es un código válido, así que `value in PROPOSAL_STATUS_VALUES` es False).
    """
    if value is None:
        return ProposalStatus.borrador.value
    if not isinstance(value, str):
        return value
    if value in PROPOSAL_STATUS_VALUES:
        return value
    legacy = LEGACY_PROPOSAL_STATUS.get(_fold(value))
    return legacy.value if legacy else value


@dataclass(frozen=True)
class StatusChangeError:
    status_code: int
    detail: str


def invalid_status_detail(destino: Any) -> str:
    return (
        f"Estado de propuesta inválido: {destino!r}. "
        f"Valores permitidos: {', '.join(s.value for s in ProposalStatus)}."
    )


def decide_cambio_estado(
    actual: Any,
    destino: Any,
    es_dueno: bool,
    es_admin: bool,
) -> Union[ProposalStatus, StatusChangeError]:
    """Pura. Decide un cambio de `proposal_status`.

    `actual` es el valor ya normalizado (normalize_proposal_status). Devuelve el
    estado nuevo o el error HTTP a responder:
      422 destino inválido; 403 propuesta ajena (salvo la reapertura por un
      admin) o reapertura sin ser admin; 409 estado actual desconocido o
      transición no permitida.
    """
    if destino not in PROPOSAL_STATUS_VALUES:
        return StatusChangeError(422, invalid_status_detail(destino))
    target = ProposalStatus(destino)
    current = ProposalStatus(actual) if actual in PROPOSAL_STATUS_VALUES else None

    if not es_dueno and not (es_admin and (current, target) in ADMIN_ONLY_TRANSITIONS):
        return StatusChangeError(403, "Access denied.")
    if current is None:
        return StatusChangeError(
            409,
            f"La propuesta tiene un estado desconocido ({actual!r}). "
            "Hay que migrarla a los estados nuevos antes de cambiarlo.",
        )
    if target not in PROPOSAL_STATUS_TRANSITIONS[current]:
        return StatusChangeError(409, f"Transición no permitida: {current.value} → {target.value}.")
    if (current, target) in ADMIN_ONLY_TRANSITIONS and not es_admin:
        return StatusChangeError(403, "Solo un administrador puede reabrir una propuesta rechazada.")
    return target


class ProposalCreate(BaseModel):
    """Fields accepted when creating a proposal.

    Extra fields sent by the dashboard's AI-assisted flow (pricing rows,
    structured content, tags, etc.) are preserved as-is.
    """
    model_config = ConfigDict(extra="allow")

    title:       str = Field(..., min_length=1, max_length=200)
    clientName:  Optional[str] = Field(None, max_length=200)
    clientEmail:   Optional[EmailStr] = None
    clientCompany: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = None
    content:     Optional[str] = None
    bookId:      Optional[str] = None


class ProposalUpdate(BaseModel):
    """Partial update — only the provided fields are modified."""
    model_config = ConfigDict(extra="allow")

    title:       Optional[str] = Field(None, min_length=1, max_length=200)
    clientName:  Optional[str] = None
    clientEmail:   Optional[EmailStr] = None
    clientCompany: Optional[str] = None
    description: Optional[str] = None
    status:      Optional[str] = None
    content:     Optional[str] = None   # HTML/markdown body


class ProposalLineItem(BaseModel):
    """A priced service included in a generated proposal."""
    model_config = ConfigDict(extra="allow")

    name:        Optional[str] = Field(None, validation_alias=AliasChoices("name", "service"))
    description: Optional[str] = None
    qty:         Optional[float] = Field(None, validation_alias=AliasChoices("qty", "quantity"))
    unitPrice:   Optional[float] = Field(None, validation_alias=AliasChoices("unitPrice", "unit_price"))


class GenerateProposalRequest(BaseModel):
    """Ask the LLM to draft/redraft the proposal body."""
    model_config = ConfigDict(extra="allow")

    title:               Optional[str] = None
    clientName:          Optional[str] = None
    description:         Optional[str] = None
    detailedDescription: Optional[str] = None
    teamSizing:          Optional[str] = None
    lineItems:           Optional[List[ProposalLineItem]] = None
    totalAmount:         Optional[float] = None
    length:              Literal["brief", "standard", "extended"] = "standard"
    style:               str = "professional"
    language:            str = "es"
    customPrompt:        Optional[str] = None
    sync:                bool = False


class ProposalVersionCreate(BaseModel):
    """Save a new version/snapshot of the proposal content."""
    model_config = ConfigDict(extra="allow")

    title:   Optional[str] = None
    content: Optional[str] = None
    label:   Optional[str] = None


class SendToCrmRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    provider: Optional[str] = None


class ExportProposalRequest(BaseModel):
    format: str = Field("pdf", pattern="^(pdf|docx)$")


class ProposalOut(BaseModel):
    """Response shape. `extra='allow'` preserves ad-hoc fields (filePath,
    crmSync, versions, totalAmount, etc.) already stored on existing
    proposal documents."""
    model_config = ConfigDict(extra="allow", from_attributes=True)

    id:          str
    title:       Optional[str] = None
    clientName:  Optional[str] = None
    clientEmail:   Optional[str] = None
    clientCompany: Optional[str] = None
    description: Optional[str] = None
    status:      Optional[str] = None
    proposal_status: Optional[str] = None
    content:     Optional[str] = None
    userId:      Optional[str] = None
    bookId:      Optional[str] = None
    downloadUrl: Optional[str] = None
    createdAt:   Optional[datetime] = None
    updatedAt:   Optional[datetime] = None


class ProposalListResponse(BaseModel):
    items: List[ProposalOut]
    total: int


class ProposalExportRequest(BaseModel):
    """Export to PDF/DOCX, optionally from the (edited) HTML currently shown in the editor."""
    format:   Literal["pdf", "docx"] = "pdf"
    content:  Optional[str] = None
    issuedBy: Optional[str] = None
