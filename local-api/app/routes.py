"""Stage 2 FastAPI routes with deterministic dummy responses."""

from typing import Annotated

from fastapi import APIRouter, Depends

from .inference import build_dummy_draft, revise_dummy_draft
from .models import (
    HealthResponse,
    ProcessInteractionRequest,
    ProcessInteractionResponse,
    ReviseDraftRequest,
    ReviseDraftResponse,
)
from .security import require_api_token


Authenticated = Annotated[None, Depends(require_api_token)]
router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health(_: Authenticated) -> HealthResponse:
    return HealthResponse()


@router.post("/process-interaction", response_model=ProcessInteractionResponse)
def process_interaction(
    request: ProcessInteractionRequest,
    _: Authenticated,
) -> ProcessInteractionResponse:
    return ProcessInteractionResponse(
        owner_id=request.owner_id,
        review_id=request.review_id,
        schema_version="1.0",
        draft=build_dummy_draft(request),
    )


@router.post("/revise-draft", response_model=ReviseDraftResponse)
def revise_draft(
    request: ReviseDraftRequest,
    _: Authenticated,
) -> ReviseDraftResponse:
    return ReviseDraftResponse(
        owner_id=request.owner_id,
        review_id=request.review_id,
        schema_version="1.0",
        draft=revise_dummy_draft(request),
    )
