"""Authenticated FastAPI routes for health and Stage 6 text inference."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from .inference import InferenceError, process_interaction as infer_interaction
from .inference import revise_draft as infer_revision
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
    try:
        draft = infer_interaction(request)
    except InferenceError as error:
        _raise_inference_error(error)
    return ProcessInteractionResponse(
        owner_id=request.owner_id,
        review_id=request.review_id,
        schema_version="1.0",
        draft=draft,
    )


@router.post("/revise-draft", response_model=ReviseDraftResponse)
def revise_draft(
    request: ReviseDraftRequest,
    _: Authenticated,
) -> ReviseDraftResponse:
    try:
        draft = infer_revision(request)
    except InferenceError as error:
        _raise_inference_error(error)
    return ReviseDraftResponse(
        owner_id=request.owner_id,
        review_id=request.review_id,
        schema_version="1.0",
        draft=draft,
    )


def _raise_inference_error(error: InferenceError) -> None:
    status_code = (
        status.HTTP_503_SERVICE_UNAVAILABLE
        if error.code == "LOCAL_API_UNAVAILABLE"
        else status.HTTP_502_BAD_GATEWAY
    )
    raise HTTPException(
        status_code=status_code,
        detail={"code": error.code, "message": error.message},
    ) from error
