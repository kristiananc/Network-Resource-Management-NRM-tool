# NRM Local API — Stage 6

Stage 6 replaces the deterministic dummy extractor with private text inference
through Ollama. It does not add vision/MMS support, a Cloudflare Tunnel, Twilio
behavior, or Worker behavior.

## Ollama dependency

The default text runtime is:

```text
Base URL: http://192.168.0.200:11434
Endpoint: /api/chat
Model: llama3.1:8b
```

`/api/chat` is used instead of `/api/generate` because the extraction contract
has an explicit system → application-context → user hierarchy. Requests use
Ollama's JSON-schema `format`, non-streaming output, and temperature zero. Raw
model text is still treated as untrusted: Python parses it and validates the
complete schema with Pydantic before producing an API response.

Optional local overrides:

```text
NRM_OLLAMA_BASE_URL=http://192.168.0.200:11434
NRM_OLLAMA_TEXT_MODEL=llama3.1:8b
NRM_OLLAMA_TIMEOUT_SECONDS=120
```

The timeout is intentionally long enough for CPU-only inference. Connection,
timeout, or Ollama HTTP failures return `LOCAL_API_UNAVAILABLE`. Malformed model
JSON is repaired once and then returns `AI_INVALID_JSON`; valid JSON that breaks
the schema is repaired once and then returns `AI_SCHEMA_ERROR`.

The model never receives the request's `owner_id`. FastAPI echoes that value
unchanged outside inference, preserving the existing tenant-boundary contract.

## Output adaptation

The model produces the complete schema-version 1.0 AI contract:

```text
schema_version
person{name,phone,email,organization,context_tag}
interaction{date,platform,summary}
identity{confidence,evidence}
warnings[]
```

The existing Apps Script integration still consumes `response.draft`.
Interaction fields remain at their existing draft locations, while `person`,
`identity`, and `warnings` are retained in `draft.details_json`. Missing
extracted values remain `null`; they are not invented merely to satisfy the
downstream draft.

`interaction.summary` intentionally omits the person's name because the same
validated response already carries it in `person.name`. The summary records the
substance or purpose of the interaction, avoiding duplicated identity data.

Revisions use a separate validated field-patch schema. The model returns only
the fields named by the correction, and Python applies those changes to a copy
of the existing draft. Unmentioned fields are therefore preserved by code, not
merely by a prompt instruction.

## Run locally

From the repository root:

```shell
python3 -m venv local-api/.venv
local-api/.venv/bin/pip install -r local-api/requirements-dev.txt
NRM_INTERNAL_API_TOKEN=replace-with-a-local-secret \
  PYTHONPATH=local-api \
  local-api/.venv/bin/python -m uvicorn app.main:app \
  --host 127.0.0.1 --port 8000
```

Every endpoint requires `Authorization: Bearer <token>`, including `/health`.
`NRM_INTERNAL_API_TOKEN` is required and is never committed or logged.

`NRM_LOCAL_API_BASE_URL` is not required by FastAPI itself. It is the separate
Apps Script configuration value that will point to the tunnel URL in a later
stage. No tunnel is configured in Stage 6.

## Unit tests

The unit suite mocks Ollama so malformed JSON, schema violations, repair limits,
outages, prompt isolation, and revision preservation are deterministic:

```shell
PYTHONPATH=local-api python3 -m unittest discover -s local-api/tests -v
```

## Live regression corpus

The versioned corpus is `local-api/regression/corpus.json`. It includes new and
existing contact references, an ambiguous date, a missing organization, two
synthetic owners, and a correction that must change only the platform.

With Ollama reachable:

```shell
PYTHONPATH=local-api python3 local-api/scripts/run_regression.py
```

Run one case in isolation with:

```shell
PYTHONPATH=local-api python3 local-api/scripts/run_regression.py \
  --case new_contact_event
```

The runner prints each input, the complete validated model output, individual
field mismatches, and a final pass/fail count. Run it after every model or prompt
change.
