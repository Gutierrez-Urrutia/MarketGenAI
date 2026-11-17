"""Pydantic schemas for the service catalog (RF-VTA-02)."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field, ValidationInfo, field_validator

Currency = Literal["USD", "CLP"]

CONDITIONS_MAX_LENGTH = 1000
USD_MAX_DECIMALS = 2


def collapse_spaces(value: str) -> str:
    """Trim and collapse inner whitespace ("  Mesa   de ayuda " -> "Mesa de ayuda")."""
    return " ".join(value.split())


def parse_price(value: Any) -> Decimal:
    """Turn the raw JSON price into a Decimal, rejecting empty, non-numeric and
    non-finite values. Floats go through ``str`` so 10.555 stays 10.555."""
    if value is None or isinstance(value, bool):
        raise ValueError("Price is required and must be a number.")
    if isinstance(value, str) and not value.strip():
        raise ValueError("Price is required and must be a number.")
    try:
        price = Decimal(str(value).strip())
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("Price must be a number.") from exc
    if not price.is_finite():
        raise ValueError("Price must be a finite number.")
    return price


def validate_price_for_currency(price: Decimal, currency: str) -> None:
    """Price rules shared by create and update: > 0; USD up to 2 decimals; CLP integers."""
    if price <= 0:
        raise ValueError("Price must be greater than 0.")
    if currency == "CLP":
        if price != price.to_integral_value():
            raise ValueError("CLP prices must be whole numbers (no decimals).")
    elif currency == "USD":
        exponent = price.normalize().as_tuple().exponent
        if isinstance(exponent, int) and -exponent > USD_MAX_DECIMALS:
            raise ValueError("USD prices allow at most 2 decimals.")


def price_to_number(price: Decimal, currency: str) -> float | int:
    """Stored as a plain number, like ``unitPrice`` in proposals."""
    if currency == "CLP" or price == price.to_integral_value():
        return int(price)
    return float(price)


def _reject_null(value: Any) -> Any:
    if value is None:
        raise ValueError("This field cannot be null.")
    return value


# ── Service types ─────────────────────────────────────────────────────────────
class ServiceTypeCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)

    @field_validator("name", mode="before")
    @classmethod
    def _clean_name(cls, v: Any) -> Any:
        return collapse_spaces(v) if isinstance(v, str) else v


class ServiceTypeUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    active: Optional[bool] = None

    @field_validator("name", "active", mode="before")
    @classmethod
    def _not_null(cls, v: Any) -> Any:
        v = _reject_null(v)
        return collapse_spaces(v) if isinstance(v, str) else v


class ServiceTypeOut(BaseModel):
    id: str
    name: str
    active: bool = True
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None


class ServiceTypeListResponse(BaseModel):
    items: List[ServiceTypeOut]
    total: int


# ── Services ──────────────────────────────────────────────────────────────────
class ServiceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    unit: str = Field(..., min_length=1, max_length=50)
    typeId: str = Field(..., min_length=1)
    # `currency` is declared before `price` so the price validator can read it.
    currency: Currency
    price: Decimal
    conditions: Optional[str] = Field("", max_length=CONDITIONS_MAX_LENGTH)

    @field_validator("name", "unit", mode="before")
    @classmethod
    def _clean_text(cls, v: Any) -> Any:
        return collapse_spaces(v) if isinstance(v, str) else v

    @field_validator("price", mode="before")
    @classmethod
    def _parse_price(cls, v: Any) -> Decimal:
        return parse_price(v)

    @field_validator("price")
    @classmethod
    def _check_price(cls, v: Decimal, info: ValidationInfo) -> Decimal:
        currency = info.data.get("currency")
        if currency:
            validate_price_for_currency(v, currency)
        return v


class ServiceUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    unit: Optional[str] = Field(None, min_length=1, max_length=50)
    typeId: Optional[str] = Field(None, min_length=1)
    currency: Optional[Currency] = None
    price: Optional[Decimal] = None
    conditions: Optional[str] = Field(None, max_length=CONDITIONS_MAX_LENGTH)
    active: Optional[bool] = None

    @field_validator("name", "unit", "typeId", "currency", "price", "active", mode="before")
    @classmethod
    def _not_null(cls, v: Any) -> Any:
        v = _reject_null(v)
        return collapse_spaces(v) if isinstance(v, str) else v

    @field_validator("price", mode="before")
    @classmethod
    def _parse_price(cls, v: Any) -> Decimal:
        return parse_price(v)

    @field_validator("price")
    @classmethod
    def _check_price(cls, v: Decimal, info: ValidationInfo) -> Decimal:
        # Only checkable here when the currency travels in the same request;
        # otherwise the router validates against the stored currency.
        currency = info.data.get("currency")
        if currency:
            validate_price_for_currency(v, currency)
        elif v <= 0:
            raise ValueError("Price must be greater than 0.")
        return v


class ServiceOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    unit: str
    typeId: str
    typeName: Optional[str] = None
    price: float
    currency: str
    conditions: Optional[str] = ""
    active: bool = True
    createdBy: Optional[str] = None
    updatedBy: Optional[str] = None
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None


class ServiceListResponse(BaseModel):
    items: List[ServiceOut]
    total: int
