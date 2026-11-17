"""Pydantic schemas for the Customers module."""
from __future__ import annotations

from datetime import datetime
from typing import Any, List, Optional

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.services.customer_profile_service import parse_industry, parse_size


class _ProfileFields(BaseModel):
    """Industria y tamaño (RF-VTA-03): opcionales; si vienen, se validan. Vacío = sin dato."""

    @field_validator("industry", check_fields=False, mode="before")
    @classmethod
    def _check_industry(cls, v: Any) -> Optional[str]:
        return parse_industry(v)

    @field_validator("size", check_fields=False, mode="before")
    @classmethod
    def _check_size(cls, v: Any) -> Optional[str]:
        return parse_size(v)


class CustomerCreate(_ProfileFields):
    name:    str = Field(..., min_length=1, max_length=200)
    email:   EmailStr
    company: Optional[str] = None
    phone:   Optional[str] = None
    notes:   Optional[str] = None
    industry: Optional[str] = None
    size:     Optional[str] = None


class CustomerUpdate(_ProfileFields):
    name:    Optional[str]  = Field(None, min_length=1, max_length=200)
    email:   Optional[EmailStr] = None
    company: Optional[str]  = None
    phone:   Optional[str]  = None
    notes:   Optional[str]  = None
    industry: Optional[str] = None
    size:     Optional[str] = None


class CustomerOut(BaseModel):
    id:        str
    name:      str
    email:     str
    company:   Optional[str] = None
    phone:     Optional[str] = None
    notes:     Optional[str] = None
    industry:  Optional[str] = None
    size:      Optional[str] = None
    industryLabel: Optional[str] = None
    sizeLabel:     Optional[str] = None
    userId:    str
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None

    class Config:
        from_attributes = True


class CustomerListResponse(BaseModel):
    items: List[CustomerOut]
    total: int


class CustomerProposalOut(BaseModel):
    """Una fila del historial de propuestas del cliente."""
    id:              str
    title:           Optional[str] = None
    status:          Optional[str] = None
    proposal_status: Optional[str] = None
    createdAt:       Optional[datetime] = None


class CustomerProposalsResponse(BaseModel):
    items: List[CustomerProposalOut]
    total: int
