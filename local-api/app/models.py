"""Pydantic contracts for the Stage 2 local API skeleton."""

from datetime import date
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


SCHEMA_VERSION = "1.0"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Platform(str, Enum):
    IN_PERSON = "IN_PERSON"
    TEXT = "TEXT"
    CALL = "CALL"
    EMAIL = "EMAIL"
    LINKEDIN = "LINKEDIN"
    INSTAGRAM = "INSTAGRAM"
    EVENT = "EVENT"
    VIDEO_CALL = "VIDEO_CALL"
    OTHER = "OTHER"


class OwnerPassthroughModel(StrictModel):
    owner_id: str = Field(min_length=1)

    @field_validator("owner_id")
    @classmethod
    def owner_id_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("owner_id must not be blank")
        return value


class ProcessInteractionRequest(OwnerPassthroughModel):
    review_id: str = Field(min_length=1)
    raw_body: str = ""
    media_refs: list[str] = Field(default_factory=list)


class InteractionDraft(StrictModel):
    interaction_date: date
    platform: Platform
    summary: str = Field(min_length=1)
    details_json: dict[str, Any] | None = None
    raw_body: str | None = None
    media_refs: list[str] = Field(default_factory=list)
    ai_model: str = Field(min_length=1)
    schema_version: Literal["1.0"] = SCHEMA_VERSION


class ProcessInteractionResponse(OwnerPassthroughModel):
    review_id: str
    schema_version: Literal["1.0"] = SCHEMA_VERSION
    draft: InteractionDraft


class ReviseDraftRequest(OwnerPassthroughModel):
    review_id: str = Field(min_length=1)
    draft: InteractionDraft
    correction: str = Field(min_length=1)


class ReviseDraftResponse(OwnerPassthroughModel):
    review_id: str
    schema_version: Literal["1.0"] = SCHEMA_VERSION
    draft: InteractionDraft


class HealthResponse(StrictModel):
    status: Literal["ok"] = "ok"
    service: Literal["nrm-local-api"] = "nrm-local-api"
    schema_version: Literal["1.0"] = SCHEMA_VERSION
