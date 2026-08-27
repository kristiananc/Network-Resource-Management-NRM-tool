# NRM Architecture — Stage 0 Design Freeze

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

### Google Apps Script

- Orchestrates workflow state.
- Owns Google Sheets access.
- Owns deterministic contact resolution and human-review routing.
- Never derives `owner_id`.

### Google Sheets

- Early-stage shared persistence layer.
- Contains Contacts, Interactions, Staging, and EventLog.
- Every row in every table contains `owner_id`.

### Cloudflare Tunnel

- Provides a managed private path to the local FastAPI service.
- Avoids exposing the local host through direct port forwarding.

### Local FastAPI

- Stable local inference boundary.
- Routes text and media-bearing requests to local models.
- Accepts `owner_id` only as opaque passthrough/traceability data.
- Does not make tenant or contact-identity decisions.

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
