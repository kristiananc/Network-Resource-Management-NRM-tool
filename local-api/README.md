# NRM Local API — Stage 2

Stage 2 provides authenticated FastAPI endpoints with deterministic dummy
responses. It does not invoke an LLM/VLM, establish a Cloudflare Tunnel, or
implement Twilio/Worker behavior.

## Run locally

From the repository root:

```shell
python3 -m venv local-api/.venv
local-api/.venv/bin/pip install -r local-api/requirements-dev.txt
NRM_INTERNAL_API_TOKEN=replace-with-a-local-secret \
  PYTHONPATH=local-api \
  local-api/.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Every endpoint requires `Authorization: Bearer <token>`, including `/health`.
The token is read from `NRM_INTERNAL_API_TOKEN`; it is never committed or
logged.

## Test

```shell
PYTHONPATH=local-api python3 -m unittest discover -s local-api/tests -v
```
