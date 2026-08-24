# NRM Schema Specification — Version 1.0

**Schema version:** `1.0`  
**Status:** Frozen for Stage 0  
**Tenant boundary:** `owner_id`

This document defines the four Google Sheets tables used by NRM version 1.0. Every table contains `owner_id` because NRM is designed for a small multi-user beta group using a shared data store.

## Global ownership invariant

`owner_id` is resolved exactly once by the Cloudflare Worker after validating the inbound Twilio request and matching the verified sender phone number against the authorized-sender map.

Downstream components must treat `owner_id` as trusted, opaque passthrough data from that authenticated boundary. Apps Script, FastAPI, the LLM/VLM, and persistence helpers must not derive or re-derive it.

All data-access operations must apply `owner_id` as a hard filter **before** identity resolution, matching, candidate generation, reads, updates, deletes, merges, or writes.

Cross-owner matching, merging, candidate exposure, or mutation is prohibited.

---

## 1. Contacts

A Contact is a durable person/entity record owned by exactly one NRM user. Contact names are not primary keys; `contact_id` is immutable.

**Header order**

```text
contact_id | owner_id | display_name | context_tag | phone | email | organization | role_title | relationship_summary | last_contact | last_platform | created_at | updated_at | status
```

| Field | Type | Required | Description |
|---|---|---:|---|
| `contact_id` | string / UUID | Yes | Permanent immutable contact identifier. |
| `owner_id` | string | Yes | Tenant identifier established at the Worker. All contact access is owner-scoped. |
| `display_name` | string | Yes | Current preferred display name. |
| `context_tag` | string | No | Human-readable disambiguator such as NAVWAR, USC, Work, Toastmasters. |
| `phone` | string / null | No | Known phone number, normalized where practical. |
| `email` | string / null | No | Known email address, normalized where practical. |
| `organization` | string / null | No | Organization or group association. |
| `role_title` | string / null | No | Optional title or role. |
| `relationship_summary` | string / null | No | High-level evolving relationship summary; never a substitute for interaction history. |
| `last_contact` | date / datetime / null | No | Latest approved interaction date, derived or updated from committed history. |
| `last_platform` | Platform enum / null | No | Platform of the latest approved interaction. |
| `created_at` | datetime | Yes | Contact creation timestamp. |
| `updated_at` | datetime | Yes | Most recent profile update timestamp. |
| `status` | Contact Status enum | Yes | `ACTIVE`, `ARCHIVED`, or `MERGED`. |

### Contacts invariants

- `contact_id` is immutable.
- The same real-world person may legitimately appear as separate contacts under different `owner_id` values.
- Contact search and identity resolution never operate across owners.
- Automatic cross-owner merges are forbidden.

---

## 2. Interactions

An Interaction is an append-oriented historical event. It records what occurred without overwriting prior relationship history.

**Header order**

```text
interaction_id | contact_id | owner_id | interaction_date | platform | summary | details_json | raw_body | media_refs | source_message_sid | created_at | ai_model | schema_version
```

| Field | Type | Required | Description |
|---|---|---:|---|
| `interaction_id` | string / UUID | Yes | Immutable interaction identifier. |
| `contact_id` | string / UUID | Yes | References the Contact associated with this event. |
| `owner_id` | string | Yes | Tenant identifier copied into the interaction row for direct owner filtering and ownership validation. |
| `interaction_date` | date / datetime | Yes | When the interaction occurred; may differ from ingestion time. |
| `platform` | Platform enum | Yes | Approved interaction medium. |
| `summary` | text | Yes | Human-approved concise synopsis. |
| `details_json` | JSON string / null | No | Optional structured details/topics for future use. |
| `raw_body` | text / null | No | Original user capture if retention is enabled. |
| `media_refs` | JSON string / null | No | Source-media metadata or retained references. |
| `source_message_sid` | string / null | No | Original Twilio MessageSid used for provenance/idempotency. |
| `created_at` | datetime | Yes | Permanent commit timestamp. |
| `ai_model` | string / null | No | Model identifier used for extraction, if applicable. |
| `schema_version` | string | Yes | Extraction/output contract version; `1.0` for this schema. |

### Interactions invariants

- `interaction_id` is immutable.
- Interaction history is preserved rather than overwritten.
- Before commit, the application must verify that the selected `contact_id` belongs to the same `owner_id` as the staged review.
- An `OWNER_MISMATCH` condition must hard-fail rather than write an interaction.

---

## 3. Staging

Staging stores durable temporary workflow state while a capture is processed, disambiguated, reviewed, revised, or held after an error.

**Header order**

```text
review_id | message_sid | owner_number | owner_id | state | created_at | updated_at | raw_body | media_json | candidate_contact_ids | selected_contact_id | draft_json | revision_count | error_json
```

| Field | Type | Required | Description |
|---|---|---:|---|
| `review_id` | string / UUID | Yes | Unique NRM workflow identifier for the capture/review lifecycle. |
| `message_sid` | string | Yes | Inbound Twilio MessageSid; first-line duplicate protection. |
| `owner_number` | string | Yes | Authorized sender phone number received from the trusted edge event. |
| `owner_id` | string | Yes | Tenant identifier resolved once by the Worker and propagated unchanged. |
| `state` | Workflow State enum | Yes | Current review/workflow state. |
| `created_at` | datetime | Yes | Staging lifecycle creation timestamp. |
| `updated_at` | datetime | Yes | Most recent staging update timestamp. |
| `raw_body` | text / null | No | Original SMS/MMS caption/body. |
| `media_json` | JSON string / null | No | Array/object containing normalized media metadata/references. |
| `candidate_contact_ids` | JSON string / null | No | Candidate IDs generated only from Contacts having the same `owner_id`. |
| `selected_contact_id` | string / UUID / null | No | Contact selected through deterministic resolution or human disambiguation. |
| `draft_json` | JSON string / null | No | Current schema-valid AI-generated interaction draft. |
| `revision_count` | integer | Yes | Number of correction/revision cycles; starts at `0`. |
| `error_json` | JSON string / null | No | Last operational error/recovery metadata. |

### Staging invariants

- `message_sid` must be checked for duplication before creating another workflow for the same inbound message.
- `owner_id` is set from the trusted Worker payload and must not be re-derived.
- `candidate_contact_ids` may contain only contacts belonging to the same `owner_id`.
- A staged review must remain recoverable when local AI is unavailable or a commit fails.

---

## 4. EventLog

EventLog records operational/audit events separately from relationship data so failures and workflow transitions can be inspected without mutating user history.

**Header order**

```text
event_id | review_id | owner_id | timestamp | event_type | status | details
```

| Field | Type | Required | Description |
|---|---|---:|---|
| `event_id` | string / UUID | Yes | Unique event-log record identifier. |
| `review_id` | string / UUID / null | No | Associated workflow identifier when the event belongs to a staged review. |
| `owner_id` | string | Yes | Tenant identifier for per-owner audit/debug filtering. |
| `timestamp` | datetime | Yes | Event occurrence timestamp. |
| `event_type` | string | Yes | Operational event name, e.g. `WEBHOOK_RECEIVED`, `AI_REQUESTED`, `AI_COMPLETED`, `REVIEW_SENT`, `COMMITTED`, `ERROR`. |
| `status` | Event Status enum | Yes | `SUCCESS`, `RETRY`, or `FAILURE`. |
| `details` | compact JSON string / null | No | Non-secret diagnostic metadata. Avoid unnecessary raw sensitive content. |

### EventLog invariants

- Log records are owner-scoped.
- Logs must never contain auth tokens, secret headers, tunnel credentials, or internal API secrets.
- Critical tenant-integrity failures such as `OWNER_MISMATCH` should be represented explicitly in `event_type` and/or `details` when later application logic is implemented.

---

# Enums

## Workflow State

```text
PROCESSING
DISAMBIGUATING
PENDING_REVIEW
REVISING
ERROR
```

| Value | Meaning |
|---|---|
| `PROCESSING` | Capture accepted and extraction/resolution is underway. |
| `DISAMBIGUATING` | Multiple or uncertain contact candidates exist within the same owner's contacts. |
| `PENDING_REVIEW` | Draft is ready for human approval or correction. |
| `REVISING` | User correction is being applied to the staged draft. |
| `ERROR` | Processing failed while recoverable staging data remains. |

`COMMITTED` is a logical terminal outcome rather than a retained staging state; after successful commit, the staging row is removed or archived according to the later implementation decision.

## Contact Status

```text
ACTIVE
ARCHIVED
MERGED
```

## Platform

```text
IN_PERSON
TEXT
CALL
EMAIL
LINKEDIN
INSTAGRAM
EVENT
VIDEO_CALL
OTHER
```

## Event Status

```text
SUCCESS
RETRY
FAILURE
```

---

# Schema versioning

The frozen schema version for Stage 0 is:

```text
1.0
```

Any later change that alters required fields, field semantics, or the extraction/output contract should be treated as an intentional schema-version change and documented before deployment.

# Secret-handling rule

No secret belongs in a table cell or other spreadsheet body content, and no secret belongs in committed source code.

Examples include Twilio tokens, Cloudflare Tunnel credentials, Worker/App Script authentication keys, FastAPI bearer/HMAC secrets, or future private API keys.

Use platform-appropriate secret storage such as Google Apps Script Script Properties, Cloudflare Worker secrets, and local environment variables/secret stores.
