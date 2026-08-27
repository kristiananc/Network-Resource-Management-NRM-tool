# Network Resource Management (NRM)

NRM is a local-AI, human-in-the-loop personal relationship-management system for a small multi-user beta group. It is designed to make relationship logging low-friction while preserving strong tenant isolation, durable interaction history, and explicit human approval before permanent writes.

## Development status

**Stage 0 — Repository, Configuration, and Design Freeze is complete.** The
historical Apps Script prototype was restored as a read-only archive in commit
`b6d1bbe` (`Update original_apps_script.gs`), closing the final Stage 0
documentation/archive item.

No application logic should be treated as active yet. Stage 0 establishes the repository structure, schema version 1.0, enums, configuration boundaries, and the authorized-sender → `owner_id` format that later stages will implement. The file `legacy/original_apps_script.gs` is archive-only history and is not an active implementation path.

## Core architecture

```text
Phone
  │ SMS / MMS
  ▼
Twilio
  │ signed webhook
  ▼
Cloudflare Worker / secure edge gateway
  ├─ validate Twilio signature
  ├─ normalize inbound event
  ├─ resolve verified sender phone → owner_id exactly once
  └─ forward authenticated normalized event
  ▼
Google Apps Script
  ├─ workflow state machine
  ├─ Google Sheets persistence
  └─ outbound review messages
  │
  ▼
Cloudflare Tunnel
  ▼
Local FastAPI service
  ├─ local text LLM
  └─ local vision-language model
  │
  ▼
Strict JSON draft
  │
  ▼
Owner-scoped contact resolution + human review
  │
  ▼
Google Sheets commit
```

The intended data store contains four logical tables/tabs:

- `Contacts`
- `Interactions`
- `Staging`
- `EventLog`

Every table includes `owner_id`.

## Non-negotiable multi-tenant rule

`owner_id` is the single tenant boundary in NRM.

1. The Cloudflare Worker validates the inbound Twilio request.
2. The Worker maps the verified sender phone number to an authorized `owner_id`.
3. That `owner_id` is passed downstream unchanged.
4. No downstream component derives, re-derives, substitutes, or infers `owner_id`.
5. All Google Sheets reads, matches, updates, and writes are hard-filtered by `owner_id` before any other logic runs.
6. Contact resolution and disambiguation candidates are restricted to the current owner's records.
7. Cross-owner matching, merging, candidate exposure, or writes are prohibited.
8. The local LLM/VLM treats `owner_id` as opaque passthrough only and never reasons about tenant ownership.

A later commit path must also verify that any selected `contact_id` belongs to the same `owner_id` as the staged review before an interaction can be written.

## Development philosophy: backbone first

NRM is intentionally being built from the capture-to-persistence backbone outward.

The first objective is not advanced AI, retrieval, embeddings, dashboards, or proactive relationship intelligence. The first objective is a trustworthy pipeline in which a capture can be received, attributed to the correct owner, staged durably, interpreted into a schema-valid draft, reviewed by the user, and committed exactly once to the correct owner-scoped records.

Development order therefore prioritizes:

```text
capture → authentication → owner attribution → staging → review → persistence → recovery
```

Only after that path is reliable should the project add:

- semantic retrieval or RAG
- embeddings/vector storage
- relationship briefs
- reconnect prioritization
- dashboards or network visualizations
- proactive recommendations
- additional ingestion channels

This ordering keeps unreliable intelligence features from being built on top of untrusted or incorrectly scoped data.

## Repository layout

```text
nrm/
├── README.md
├── docs/
│   ├── architecture.md
│   ├── schemas.md
│   └── test-cases.md
├── apps-script/
│   ├── Code.gs
│   ├── Config.gs
│   ├── Twilio.gs
│   ├── StateMachine.gs
│   ├── Sheets.gs
│   ├── LocalAI.gs
│   └── Utils.gs
├── worker/
│   ├── src/
│   │   ├── index.ts
│   │   └── owner-map.ts
│   └── wrangler.jsonc
├── local-api/
│   ├── app/
│   │   ├── main.py
│   │   ├── models.py
│   │   ├── routes.py
│   │   ├── inference.py
│   │   ├── media.py
│   │   └── security.py
│   └── tests/
└── legacy/
    └── original_apps_script.gs  # read-only historical archive; not active code
```

## Configuration boundaries

Configuration falls into two categories.

### Non-secret configuration

Examples:

- schema version
- allowed enum values
- deployment URLs that are safe to expose
- sheet/tab names
- retry limits
- non-sensitive feature flags
- authorized sender → `owner_id` identifiers, if the project owner accepts those phone numbers being present in Worker source/config

Where practical, keep environment-specific non-secret values in explicit config files rather than scattering them through application code.

### Secrets

**Secrets must never be stored in the Google Sheet body or committed to source control.**

This includes, at minimum:

- Twilio Auth Token
- Twilio API credentials
- Worker → Apps Script shared secret/HMAC key
- FastAPI internal bearer/HMAC secret
- Cloudflare Tunnel credentials/tokens
- any future service-account or API private keys

Use the secret mechanism appropriate to each platform, such as:

- Google Apps Script Properties / Script Properties
- Cloudflare Worker secrets
- local environment variables or an OS-backed/local secret store

The repository should contain only variable names, documentation, and safe placeholders—not real secret values.

## Stage 0 design freeze

The following are frozen for schema version `1.0`:

- the four table names
- all v1 headers in `docs/schemas.md`
- `owner_id` on all four tables
- workflow, contact-status, platform, and event-status enums
- Worker-only sender → `owner_id` resolution
- downstream `owner_id` passthrough behavior
- application-owned contact resolution
- human approval before permanent interaction commits

Changes to these contracts after Stage 0 should be intentional and documented as schema or architecture changes rather than introduced ad hoc.

## Stage 0 exit gate

Stage 0 is complete when:

- repository scaffolding exists;
- schema version 1.0 is documented;
- all four schemas contain `owner_id`;
- enums are documented;
- the authorized-sender → `owner_id` format is concrete and ready for real beta-user values;
- the legacy prototype is archived as reference rather than treated as the active implementation path; and
- no secrets are present in the spreadsheet body or source control.
