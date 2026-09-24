"""Pydantic contracts for the NRM local API and Stage 6 AI output."""

from datetime import date
from enum import Enum
from typing import Annotated, Any, Literal

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


class ExtractedPerson(StrictModel):
    name: str | None
    phone: str | None
    email: str | None
    organization: str | None
    context_tag: str | None


class ExtractedInteraction(StrictModel):
    date: date | None
    platform: Platform | None
    summary: str | None

    @field_validator("summary")
    @classmethod
    def summary_must_not_be_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("summary must be null or non-blank")
        return value


class IdentityAssessment(StrictModel):
    confidence: float = Field(ge=0.0, le=1.0)
    evidence: list[str]


class AIOutputContract(StrictModel):
    schema_version: Literal["1.0"]
    person: ExtractedPerson
    interaction: ExtractedInteraction
    identity: IdentityAssessment
    warnings: list[str]


class PersonRevisionChange(StrictModel):
    field: Literal[
        "person.name",
        "person.phone",
        "person.email",
        "person.organization",
        "person.context_tag",
    ]
    value: str | None


class InteractionDateRevisionChange(StrictModel):
    field: Literal["interaction.date"]
    value: date | None


class InteractionPlatformRevisionChange(StrictModel):
    field: Literal["interaction.platform"]
    value: Platform | None


class InteractionSummaryRevisionChange(StrictModel):
    field: Literal["interaction.summary"]
    value: str | None

    @field_validator("value")
    @classmethod
    def summary_must_not_be_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("summary must be null or non-blank")
        return value


class IdentityConfidenceRevisionChange(StrictModel):
    field: Literal["identity.confidence"]
    value: float = Field(ge=0.0, le=1.0)


class StringListRevisionChange(StrictModel):
    field: Literal["identity.evidence", "warnings"]
    value: list[str]


RevisionChange = Annotated[
    PersonRevisionChange
    | InteractionDateRevisionChange
    | InteractionPlatformRevisionChange
    | InteractionSummaryRevisionChange
    | IdentityConfidenceRevisionChange
    | StringListRevisionChange,
    Field(discriminator="field"),
]


class RevisionPatch(StrictModel):
    schema_version: Literal["1.0"]
    changes: list[RevisionChange]

    @field_validator("changes")
    @classmethod
    def fields_must_be_unique(cls, value: list[RevisionChange]) -> list[RevisionChange]:
        fields = [change.field for change in value]
        if len(fields) != len(set(fields)):
            raise ValueError("each revision field may appear at most once")
        return value


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
    interaction_date: date | None
    platform: Platform | None
    summary: str | None
    details_json: dict[str, Any] | None = None
    raw_body: str | None = None
    media_refs: list[str] = Field(default_factory=list)
    ai_model: str = Field(min_length=1)
    schema_version: Literal["1.0"] = SCHEMA_VERSION

    @field_validator("summary")
    @classmethod
    def draft_summary_must_not_be_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("summary must be null or non-blank")
        return value


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
