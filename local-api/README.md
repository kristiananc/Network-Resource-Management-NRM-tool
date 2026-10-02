# NRM Local API — Stages 6–7

Stage 6 replaces the deterministic dummy extractor with private text inference
through Ollama. Stage 7 adds authenticated temporary Twilio-media downloads and
routes image-bearing captures to a separate local vision model. The public API
and schema-version 1.0 draft contract are unchanged.

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
NRM_OLLAMA_VISION_MODEL=qwen2.5vl:3b
NRM_OLLAMA_TIMEOUT_SECONDS=120
```

The timeout is intentionally long enough for CPU-only inference. Connection,
timeout, or Ollama HTTP failures return `LOCAL_API_UNAVAILABLE`. Malformed model
JSON is repaired once and then returns `AI_INVALID_JSON`; valid JSON that breaks
the schema is repaired once and then returns `AI_SCHEMA_ERROR`.

The model never receives the request's `owner_id`. FastAPI echoes that value
unchanged outside inference, preserving the existing tenant-boundary contract.

## Vision/MMS dependency and routing

The known Windows Ollama inventory (`llama3.1:8b`, `qwen2.5-coder:7b`, and
`phi3:mini`) contains no vision model. Stage 7 therefore targets
`qwen2.5vl:3b`, a 3.2 GB text-and-image model chosen for the CPU-only host and
its document/text and structured-output focus. Its presence on the Windows
machine cannot be checked from this repository environment. Install and verify
it manually:

```powershell
ollama pull qwen2.5vl:3b
ollama list
```

The model requires Ollama 0.7.0 or newer. `ollama list` must contain
`qwen2.5vl:3b` before live MMS testing.

Routing is based only on `media_refs`:

- no media: existing `llama3.1:8b` text path, unchanged;
- one or more media URLs: authenticated download followed by
  `qwen2.5vl:3b` vision inference;
- an empty caption is valid for image-only extraction;
- a supplied caption is explicitly higher-priority semantic guidance than
  conflicting image text.

Ollama receives base64 image data through `/api/chat` and the same Pydantic JSON
schema used by text extraction. Vision output therefore has the same
`person`, `interaction`, `identity`, and `warnings` structure and requires no
downstream Apps Script or Sheets change.

Official references:

- https://ollama.com/library/qwen2.5vl:3b
- https://ollama.com/blog/structured-outputs

## Secure Twilio media downloads

Twilio media downloads require local credentials separate from the copies used
by the Worker or Apps Script:

```text
NRM_TWILIO_ACCOUNT_SID=<Twilio Account SID>
NRM_TWILIO_AUTH_TOKEN=<Twilio Auth Token>
```

These values belong only in `scripts/windows/local-api.env`, which is ignored
by Git. The downloader uses HTTP Basic authentication, sends credentials only
to HTTPS `api.twilio.com` media-resource URLs, rejects redirects, and never logs
the URL or credentials. Missing credentials return `MEDIA_CONFIG_ERROR`.

The bounds for new untrusted media input are deliberately narrower than a
general file-upload service:

- at most 4 images per request;
- at most 5 MiB per image;
- at most 10 MiB total;
- only JPEG, PNG, and WebP;
- both the HTTP content type and file signature must identify an allowed image.

These formats cover business cards, contact/event screenshots, and ordinary
photos while excluding animated images and arbitrary documents. Each request
uses a uniquely scoped OS temporary directory. That directory is deleted in a
`finally` block after successful inference, download failure, schema failure,
or Ollama failure. There is no retention toggle: deletion is always the Stage 7
default. Only the pre-existing remote `media_refs` metadata remains in the
draft; no downloaded image is retained on local disk.

Twilio reference:

- https://www.twilio.com/docs/messaging/api/media-resource

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

## Run persistently on Windows

The versioned Windows launcher reads secrets and runtime settings from a local,
gitignored environment file, binds Uvicorn to `127.0.0.1:8000`, and records
launcher, stdout, and stderr logs under `local-api/logs/`. NSSM wraps that
launcher as an automatic Windows service and restarts it after a crash.

Follow [`docs/windows-service-setup.md`](../docs/windows-service-setup.md) on
the Windows server. The repository does not install or operate that service
remotely.

## Unit tests

The unit suite mocks Ollama so malformed JSON, schema violations, repair limits,
outages, prompt isolation, and revision preservation are deterministic:

```shell
PYTHONPATH=local-api python3 -m unittest discover -s local-api/tests -v
```

The revision path additionally enforces semantic scope after schema validation:
a new organization/context or substantive topic requires a refreshed summary,
while date and platform changes require supporting cues in the correction. A
violating model patch receives the same single repair attempt as malformed or
schema-invalid output; a second violation fails instead of being merged.

Run the deterministic revision regression to print complete before/after draft
JSON for the substantive-summary, typo-preservation, and unsupported-field
cases:

```shell
PYTHONPATH=local-api python3 local-api/scripts/run_revision_regression.py
```

Stage 7 media and vision tests also run as part of the full suite. Print the
actual temporary-directory state before, during, and after successful and
failed inference with:

```shell
PYTHONPATH=local-api python3 local-api/scripts/run_stage7_regression.py
```

## Live regression corpus

The versioned corpus is `local-api/regression/corpus.json`. It includes new and
existing contact references, an ambiguous date, a missing organization, two
synthetic owners, a platform-only correction, and the three revision-scope
scenarios covered by the deterministic runner above.

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
