"""Authenticated FastAPI routes for local text, revision, and vision inference."""

import json
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

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
LOGGER = logging.getLogger("nrm.api")
router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health(_: Authenticated) -> HealthResponse:
    return HealthResponse()


@router.post("/process-interaction", response_model=ProcessInteractionResponse)
def process_interaction(
    request: ProcessInteractionRequest,
    http_request: Request,
    _: Authenticated,
) -> ProcessInteractionResponse:
    try:
        draft = infer_interaction(request)
    except InferenceError as error:
        _raise_inference_error(error, http_request=http_request)
    return ProcessInteractionResponse(
        owner_id=request.owner_id,
        review_id=request.review_id,
        schema_version="1.0",
        draft=draft,
    )


@router.post("/revise-draft", response_model=ReviseDraftResponse)
def revise_draft(
    request: ReviseDraftRequest,
    http_request: Request,
    _: Authenticated,
) -> ReviseDraftResponse:
    try:
        draft = infer_revision(request)
    except InferenceError as error:
        _raise_inference_error(error, http_request=http_request)
    return ReviseDraftResponse(
        owner_id=request.owner_id,
        review_id=request.review_id,
        schema_version="1.0",
        draft=draft,
    )


def _raise_inference_error(error: InferenceError, *, http_request: Request) -> None:
    status_code = (
        status.HTTP_503_SERVICE_UNAVAILABLE
        if error.code in {"LOCAL_API_UNAVAILABLE", "MEDIA_CONFIG_ERROR"}
        else status.HTTP_502_BAD_GATEWAY
    )
    LOGGER.error(
        json.dumps(
            {
                "diagnostic": error.diagnostic,
                "error_code": error.code,
                "event": "inference_error",
                "exception_type": _root_exception_type(error),
                "message": error.message,
                "path": http_request.url.path,
                "request_id": getattr(http_request.state, "request_id", "unknown"),
                "stage": error.stage,
                "status_code": status_code,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    raise HTTPException(
        status_code=status_code,
        detail={"code": error.code, "message": error.message},
    ) from error


def _root_exception_type(error: BaseException) -> str:
    root = error
    seen: set[int] = set()
    while root.__cause__ is not None and id(root.__cause__) not in seen:
        seen.add(id(root))
        root = root.__cause__
    return type(root).__name__
