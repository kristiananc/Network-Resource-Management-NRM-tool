"""Deterministic Stage 2 dummy inference; no model is invoked."""

from datetime import date

from .models import (
    InteractionDraft,
    Platform,
    ProcessInteractionRequest,
    ReviseDraftRequest,
)


DUMMY_MODEL = "stage2-dummy"
DUMMY_DATE = date(2000, 1, 1)


def build_dummy_draft(request: ProcessInteractionRequest) -> InteractionDraft:
    return InteractionDraft(
        interaction_date=DUMMY_DATE,
        platform=Platform.OTHER,
        summary="Stage 2 deterministic dummy interaction.",
        details_json={"mode": "dummy"},
        raw_body=request.raw_body,
        media_refs=request.media_refs,
        ai_model=DUMMY_MODEL,
        schema_version="1.0",
    )


def revise_dummy_draft(request: ReviseDraftRequest) -> InteractionDraft:
    return InteractionDraft(
        interaction_date=request.draft.interaction_date,
        platform=request.draft.platform,
        summary="Stage 2 deterministic revised dummy interaction.",
        details_json={"mode": "dummy", "revision_applied": True},
        raw_body=request.draft.raw_body,
        media_refs=request.draft.media_refs,
        ai_model=DUMMY_MODEL,
        schema_version="1.0",
    )
