"""NRM Stage 2 FastAPI application."""

import json
import logging
import time
import uuid

from fastapi import FastAPI, Request

from .routes import router


LOGGER = logging.getLogger("nrm.api")
LOGGER.setLevel(logging.INFO)
if not LOGGER.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(message)s"))
    LOGGER.addHandler(_handler)
LOGGER.propagate = False

app = FastAPI(
    title="NRM Local API",
    version="0.2.0",
    description="Authenticated Stage 2 skeleton with deterministic dummy responses.",
)


@app.middleware("http")
async def structured_request_log(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    started = time.perf_counter()
    response = await call_next(request)
    duration_ms = round((time.perf_counter() - started) * 1000, 3)
    response.headers["x-request-id"] = request_id
    LOGGER.info(
        json.dumps(
            {
                "event": "http_request",
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": duration_ms,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return response


app.include_router(router)
