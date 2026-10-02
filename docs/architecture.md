# NRM Architecture — Stage 0 Design Freeze

**Status:** Complete as of commit `b6d1bbe` (`Update original_apps_script.gs`).

## Purpose

Network Resource Management (NRM) captures relationship interactions from low-friction SMS/MMS input, converts them into structured drafts with local AI, requires human review, and persists approved records in an owner-scoped shared data store.

## Target flow

```text
Phone → Twilio → Cloudflare Worker → Google Apps Script → Cloudflare Tunnel → Local FastAPI → Local LLM/VLM → Apps Script review → Google Sheets
```

## Responsibility boundaries

### Twilio

- SMS/MMS transport.
- Supplies signed inbound webhooks.

### Cloudflare Worker

- Public security boundary.
- Validates `X-Twilio-Signature`.
- Rejects unauthorized senders.
- Resolves sender phone number → `owner_id` exactly once.
- Normalizes and authenticates the downstream event.
- Does not wait on local AI before acknowledging the webhook path.

Stage 5 implements signature validation with Twilio's official request
validator using the Worker's exact received URL and every form parameter. The
verified sender is resolved in `worker/src/owner-map.ts`. The Worker then sends
Apps Script a five-minute timestamped HMAC-SHA256 envelope containing the
normalized event. Direct form posts to Apps Script are no longer trusted.

The Worker returns empty TwiML immediately and forwards to Apps Script through
`ctx.waitUntil()`. Consequently, Apps Script's eventual TwiML is not part of
Twilio's original response. Apps Script sends the resulting review or
confirmation text separately through Twilio's REST Messages API using
Script-Property credentials. Outbound failures are logged without secrets or
message content and do not alter Staging or Interaction state.

The frozen authorized-sender map shape is
`Readonly<Record<string, string>>`: each key is an authorized sender phone
number in E.164 format and each value is a stable, opaque `owner_id`. The
current production mapping lives in `worker/src/owner-map.ts`; additional
beta-user entries can be added without changing this contract.

### Google Apps Script

- Orchestrates workflow state.
- Owns Google Sheets access.
- Owns deterministic contact resolution and human-review routing.
- Never derives `owner_id`.

For a production capture, Apps Script maps the allowlisted AI identity evidence
from `draft.details_json.person` into a proposed Contact: `name` becomes
`display_name`, while `organization`, `context_tag`, `phone`, and `email` retain
their corresponding Contact fields. That proposed identity supplies the
owner-scoped contact query. A selected existing contact is reused without
creating a duplicate; when no owned match is selected, the proposed Contact is
created only after the user approves the staged draft. The commit path derives
the proposal from the latest validated interaction draft again before enforcing
required Contact fields.

The historical command-parser in `legacy/original_apps_script.gs` is a
read-only archive and is not loaded, imported, or used by this active path.

### Google Sheets

- Early-stage shared persistence layer.
- Contains Contacts, Interactions, Staging, and EventLog.
- Every row in every table contains `owner_id`.

### Cloudflare Tunnel

- Provides a managed private path to the local FastAPI service.
- Avoids exposing the local host through direct port forwarding.

The recommended later deployment is a named, remotely managed tunnel with a
published HTTPS hostname routed to `http://localhost:8000` on the FastAPI host.
The hostname should be protected with a Cloudflare Access service token in
addition to FastAPI's bearer token. Stage 5 documents this path but does not
create the tunnel or alter FastAPI.

### Local FastAPI

- Stable local inference boundary.
- Routes text and media-bearing requests to local models.
- Accepts `owner_id` only as opaque passthrough/traceability data.
- Does not make tenant or contact-identity decisions.

Stage 7 routes requests with no `media_refs` through the existing
`llama3.1:8b` text path and requests with one or more media URLs through
`qwen2.5vl:3b`. Media-bearing requests are downloaded from exact Twilio media
resource URLs with local HTTP Basic credentials. The downloader accepts at most
four JPEG/PNG/WebP images, enforces 5 MiB per-file and 10 MiB aggregate limits,
checks both HTTP type and file signature, rejects redirects, and sends
credentials only to the configured account's `api.twilio.com` resource path.
Each request uses a scoped temporary directory that is removed after success or
failure; local retention is not configurable. Vision outputs use the same
schema-version 1.0 contract as text outputs, and captions are higher-priority
semantic evidence than conflicting image text.

### Local LLM/VLM

- Extracts evidence into strict structured drafts.
- Never writes final CRM data.
- Never chooses database `contact_id` values.
- Never reasons about `owner_id`.

## Tenant isolation invariant

All owner attribution begins at the Worker and nowhere else. Downstream reads and writes are owner-scoped before any other logic executes. Cross-owner matching, merging, disambiguation, or persistence is prohibited.

## Human-in-the-loop invariant

The AI can produce or revise a draft, but a permanent interaction write requires human approval. Identity resolution remains deterministic application logic rather than an LLM decision.

## Development philosophy

Build and test the trustworthy capture → staging → review → persistence backbone first. Retrieval, RAG, embeddings, dashboards, proactive recommendations, and other intelligence features remain deferred until capture reliability, idempotency, recovery, and tenant isolation are proven.

## Secrets

Secrets never belong in the Google Sheet body or source control. Use Script Properties, Cloudflare secrets, environment variables, or another appropriate secret store.
