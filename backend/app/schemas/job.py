"""Pydantic schemas for async jobs."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel


class JobStatus(str, Enum):
    pending    = "pending"
    processing = "processing"
    completed  = "completed"
    failed     = "failed"


class JobOut(BaseModel):
    id:          str
    type:        str
    status:      JobStatus
    progress:    int            = 0
    result:      Optional[Any]  = None
    error:       Optional[str]  = None
    user_id:     str
    created_at:  datetime
    updated_at:  datetime

    class Config:
        populate_by_name = True


class JobAccepted(BaseModel):
    job_id:  str    = ""
    status:  str    = "pending"
    message: str    = "Job enqueued successfully"
