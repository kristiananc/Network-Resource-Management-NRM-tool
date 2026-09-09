# NETWORK RESOURCE MANAGEMENT

## NRM Development Blueprint

*Local-AI, Human-in-the-Loop Relationship Intelligence System*

| Document Attribute | Value |
| --- | --- |
| Project name | Network Resource Management (NRM) |
| Purpose | Capture, structure, review, preserve, and later retrieve relationship interactions from low-friction SMS/MMS inputs, for a small multi-user beta group. |
| Primary architecture | Twilio → secure webhook gateway → Apps Script orchestration → local FastAPI → local LLM/VLM → human review → Google Sheets persistence (owner-scoped, multi-tenant) |
| Development philosophy | Build the reliable capture-to-persistence backbone first. Add retrieval, analytics, and proactive intelligence only after the core data is trustworthy. |
| Multi-tenancy model | Shared data store with owner-tagged rows (owner_id). Chosen to scale cleanly to more users and to support later cross-cutting/batch processing without re-architecture. |
| Status | Approved target architecture / implementation specification |
| Date | August 24, 2026 |

**Design principle: NRM is not a contact list. It is a structured memory system for relationships, shared across a small group of beta users while keeping each person's relationship data private to them.**

> **Note on document history:** This blueprint was the original design specification for NRM. As of this addition to the repository, Stages 0–5 have been implemented, tested, and (for Stages 0–4) deployed live; Stage 5 (Secure Edge Gateway) is implemented and locally verified, with live deployment in progress pending Twilio A2P 10DLC campaign approval. Some architectural details evolved during implementation (e.g., outbound SMS replies are sent via Twilio's REST Messages API rather than synchronous TwiML, to accommodate the Stage 5 Worker's fast-acknowledgement requirement; owner-to-sender mapping moved from an Apps Script Script Property to the Cloudflare Worker's owner-map.ts as designed). Treat this document as the authoritative design intent and roadmap; treat docs/architecture.md and code comments as the authoritative record of what was actually built and any deviations.

---

# 1. Executive Summary

Network Resource Management (NRM) is a personal relationship-management system designed to make logging meaningful interactions nearly frictionless. The user captures an interaction by texting or sending an MMS to a Twilio number. The message can contain plain language, an image such as a business card or screenshot, or both. NRM interprets the evidence with locally hosted AI, resolves the referenced person against the existing contact set, generates a structured interaction draft, and asks the user to approve or correct the result before permanent storage.

The central architectural decision is to separate four concerns: capture, orchestration, intelligence, and persistence. Twilio handles communication; a secure edge gateway validates and normalizes inbound events; Google Apps Script manages workflow state and Google Sheets; and a local FastAPI service performs AI inference. The AI never receives unilateral authority to write final CRM data. Every meaningful write remains human-reviewed.

NRM is being built for a small beta group, not a single user. Contacts and interactions are therefore owner-scoped: every row belongs to exactly one authorized person, and all matching, retrieval, and writes are filtered by that ownership. This is implemented as a shared data store with an owner_id on every record, rather than one Sheet per person, so the system scales to additional users and supports later cross-user or batch processing (e.g. administrative review, analytics, migration to a real database) without restructuring the schema.

- Contacts and interactions are stored separately so history is preserved rather than overwritten.
- Each inbound message is assigned durable identifiers for idempotency, review, retry, and auditability.
- The webhook path is acknowledged quickly; expensive local AI work is decoupled from Twilio response timing.
- Local LLM/VLM models extract evidence into strict JSON. Application code—not the model—owns identity resolution, owner scoping, and database rules.
- RAG, embeddings, dashboards, automated outreach recommendations, and advanced analytics are explicitly deferred until the capture pipeline is proven reliable.

# 2. Product Definition

## 2.1 Primary Goal

Create a low-friction system that lets each authorized user preserve the substance of real-world and digital relationship interactions while minimizing manual data entry. The system should function as durable relationship memory: who someone is, where they fit into that user's network, when the relationship was last active, and what was discussed across time — kept private to that user within a shared, multi-tenant data store.

## 2.2 User Experience Goal

User sends: "Met Sarah from NAVWAR today. We discussed autonomous mine detection and she mentioned their team is looking at new data-integration approaches."

NRM replies: "Sarah Chen — NAVWAR
Aug 24 · In Person
Discussed autonomous mine detection and NAVWAR data-integration interests.

Reply YES to log, or send a correction."

## 2.3 Core Capabilities for Version 1

- Accept SMS, MMS, and text-plus-image captures.
- Extract structured person and interaction information with local AI.
- Resolve contacts deterministically using application logic and existing CRM data, scoped to the sending user's own contacts.
- Handle zero-match, unique-match, and ambiguous-match cases.
- Allow iterative SMS-based corrections before persistence.
- Preserve interaction history instead of overwriting the most recent summary.
- Protect against duplicate webhook delivery and repeated commits.
- Recover gracefully when the local AI machine is unavailable.
- Maintain a clear audit trail for every staged and committed interaction.
- Support multiple authorized beta users concurrently, each with an isolated view of their own contacts and interactions.

## 2.4 Explicit Non-Goals for the Initial Build

- Vector database or semantic search
- RAG over relationship history
- Automated outreach generation
- Web/mobile dashboard
- Automatic social-media scraping
- Automatic email/calendar ingestion
- Network graph visualization
- Predictive relationship scoring
- Cloud-hosted model inference
- Cross-user sharing or team-visible contacts (each user's data remains private within the shared store)

# 3. Target System Architecture

The approved architecture preserves the original low-cost Google Sheets concept while strengthening the weak points exposed by the prototype: security, state management, history preservation, synchronous dependency on local AI, and — for the beta phase — multi-user data isolation.

```
PHONE
  │ SMS / MMS
  ▼
TWILIO
  │ Signed webhook
  ▼
CLOUDFLARE WORKER / SECURE EDGE GATEWAY
  │ 1. Verify Twilio signature
  │ 2. Normalize inbound event
  │ 3. Resolve sender phone → owner_id
  │ 4. Acknowledge quickly
  ▼
GOOGLE APPS SCRIPT
  │ State machine + Sheets access + Twilio replies
  ├───────────────► GOOGLE SHEETS
  │                  Contacts / Interactions / Staging / EventLog
  │                  (all rows owner_id-scoped)
  │
  ▼
CLOUDFLARE TUNNEL
  ▼
LOCAL FASTAPI SERVICE (Windows laptop)
  ├───────────────► Local Text LLM
  └───────────────► Local Vision-Language Model
  │
  ▼
STRICT JSON DRAFT
  │
  ▼
CONTACT RESOLUTION (owner-scoped) + HUMAN REVIEW
  │
  └───────────────► COMMIT TO CONTACTS + INTERACTIONS
```

| Component | Responsibility | Why it exists |
| --- | --- | --- |
| Twilio | SMS/MMS transport | Reliable inbound/outbound messaging interface. |
| Cloudflare Worker | Public webhook, signature validation, normalization, sender→owner mapping, fast acknowledgement | Provides a proper HTTP security boundary and establishes which beta user a message belongs to before Apps Script runs. |
| Google Apps Script | Workflow orchestration, state machine, Sheets operations, outbound review messages | Keeps the MVP simple and integrates naturally with Sheets. |
| Google Sheets | Structured persistence and operational state, shared across users with owner_id scoping | Human-readable, inspectable, low-friction multi-tenant database for early-stage NRM. |
| Cloudflare Tunnel | Private path to the local machine | Avoids exposing the Windows host directly to the public internet. |
| FastAPI | Local AI gateway and routing | Stable API boundary independent of model runtime. |
| Local LLM | Text extraction and revision | Converts free-form descriptions to structured fields. |
| Local VLM | Image and multimodal extraction | Handles screenshots, cards, images, and caption-guided interpretation. |

# 4. Data Model

The most important schema correction is the separation of people from events. A contact is a durable entity. An interaction is an append-only historical event. Staging contains temporary workflow state. EventLog provides operational auditability. Because NRM now serves a small group of beta users rather than one person, every table below carries an owner_id field, and every read, match, and write is scoped to it. owner_id is the single multi-tenancy boundary in the system — no other mechanism is relied on to keep users' data separate.

## 4.1 Contacts Table

| Field | Type | Purpose |
| --- | --- | --- |
| contact_id | UUID/string | Permanent immutable identifier; names are not primary keys. |
| owner_id | string (FK) | Identifies which beta user this contact belongs to. Derived from the authorized sender phone number. All lookups, matches, and writes are filtered by this field. |
| display_name | string | Current preferred name. |
| context_tag | string | Human-readable disambiguator such as NAVWAR, Toastmasters, USC, Work. |
| phone | string/null | Known phone number, normalized where practical. |
| email | string/null | Known email address. |
| organization | string/null | Organization or group association. |
| role_title | string/null | Optional title/role. |
| relationship_summary | string/null | Optional high-level evolving summary; not a substitute for history. |
| last_contact | date/null | Derived or updated from latest committed interaction. |
| last_platform | string/null | Platform/medium of latest interaction. |
| created_at | datetime | Creation timestamp. |
| updated_at | datetime | Most recent profile update. |
| status | enum | ACTIVE, ARCHIVED, MERGED. |

## 4.2 Interactions Table

| Field | Type | Purpose |
| --- | --- | --- |
| interaction_id | UUID/string | Immutable interaction identifier. |
| contact_id | foreign key | Links event to a contact. |
| owner_id | string (FK) | Copied from the parent contact at write time so interaction rows can be filtered directly without a join, and so a bug in resolution cannot silently attach one user's event to another user's contact. |
| interaction_date | date/datetime | When interaction occurred; may differ from ingestion time. |
| platform | enum/string | In Person, Text, Call, Email, LinkedIn, IG, etc. |
| summary | text | Approved concise synopsis. |
| details_json | JSON/string | Optional structured facts/topics for future use. |
| raw_body | text/null | Original user text capture if retained. |
| media_refs | JSON/string | Source-media metadata or retained references. |
| source_message_sid | string/null | Inbound Twilio identifier for provenance/idempotency. |
| created_at | datetime | Commit timestamp. |
| ai_model | string/null | Model used for extraction. |
| schema_version | string | Extraction/output contract version. |

## 4.3 Staging Table

| Field | Purpose |
| --- | --- |
| review_id | Unique NRM workflow identifier generated for every new capture. |
| message_sid | Inbound Twilio MessageSid; first-line duplicate protection. |
| owner_number | Authorized sender phone number. Resolved at the edge to owner_id, which is propagated to every downstream Contact/Interaction/EventLog write for this review. |
| owner_id | The resolved tenant identifier for this capture, set once at PROCESSING and never re-derived downstream. |
| state | PROCESSING, DISAMBIGUATING, PENDING_REVIEW, REVISING, ERROR. |
| created_at / updated_at | Lifecycle timestamps. |
| raw_body | Original SMS/MMS caption. |
| media_json | Array of media URLs/content types or normalized media references. |
| candidate_contact_ids | Identity-resolution candidates when ambiguous — always drawn only from this owner_id's contacts. |
| selected_contact_id | Resolved contact once selected. |
| draft_json | Current AI-generated draft. |
| revision_count | Number of correction iterations. |
| error_json | Last operational error for retry/debugging. |

## 4.4 EventLog Table

EventLog is recommended even if the first prototype could operate without it. It separates workflow observability from user data and makes debugging significantly easier. With multiple beta users, owner_id also lets support/debugging be scoped to one user's activity without exposing others'.

| Field | Example |
| --- | --- |
| event_id | UUID |
| review_id | Associated workflow |
| owner_id | Tenant the event belongs to; enables per-user filtering of logs. |
| timestamp | 2026-08-24T16:04:12-07:00 |
| event_type | WEBHOOK_RECEIVED / AI_REQUESTED / AI_COMPLETED / REVIEW_SENT / COMMITTED / ERROR |
| status | SUCCESS / RETRY / FAILURE |
| details | Compact JSON with non-secret diagnostic metadata |

# 5. Workflow State Machine

```
NEW CAPTURE (owner_id resolved from sender)
    │
    ▼
PROCESSING ─────failure────► ERROR
    │
    ├── 0 matches (within owner_id) ──► PENDING_REVIEW (new-contact proposal)
    │
    ├── 1 confident match (within owner_id) ─► PENDING_REVIEW
    │
    └── multiple/uncertain (within owner_id) ─► DISAMBIGUATING
                                  │
                                  ▼ user selects
                            PENDING_REVIEW
                                  │
                  correction ◄────┼────► YES
                      │            │        │
                      ▼            │        ▼
                   REVISING ───────┘      COMMIT
                                              │
                                              ▼
                                    Contacts + Interactions
                                    (written with owner_id)
                                              │
                                              ▼
                                         staging deleted
```

| State | Meaning | Allowed next states |
| --- | --- | --- |
| PROCESSING | Capture accepted; sender mapped to owner_id; extraction/resolution underway. | DISAMBIGUATING, PENDING_REVIEW, ERROR |
| DISAMBIGUATING | Multiple plausible contact identities within this owner's contacts. | PENDING_REVIEW, ERROR |
| PENDING_REVIEW | Draft is ready for human approval. | REVISING, COMMITTED, ERROR |
| REVISING | User supplied correction; draft is being regenerated. | PENDING_REVIEW, ERROR |
| ERROR | Processing failed but source/staging data remains available. | PROCESSING or manual cleanup |
| COMMITTED | Logical terminal state; permanent data written under the resolved owner_id. | Staging row is removed or archived. |

# 6. API and Data Contracts

## 6.1 Normalized Inbound Event

```json
{
  "message_sid": "SM...",
  "owner_id": "own_...",
  "from": "+1...",
  "to": "+1...",
  "body": "Met Sarah from NAVWAR today...",
  "num_media": 1,
  "media": [
    {"url": "https://...", "content_type": "image/jpeg"}
  ],
  "received_at": "2026-08-24T16:04:12-07:00"
}
```

owner_id is resolved by the Worker from the verified sender number against the authorized-sender map (Section 9) before Apps Script ever sees the event. Apps Script never derives owner_id itself.

## 6.2 FastAPI: POST /process-interaction

Input contains the normalized capture plus server-generated context such as current date and permitted schema version. owner_id is passed through unchanged — FastAPI and the models never use it for anything beyond echoing it back for traceability; identity resolution against the owner's contacts happens in Apps Script, not in the AI layer. The FastAPI layer may temporarily download authenticated media when necessary, route text-only requests to the LLM, and route image-bearing requests to the VLM.

```json
{
  "review_id": "uuid",
  "owner_id": "own_...",
  "body": "Met Sarah from NAVWAR today...",
  "media": [...],
  "received_at": "...",
  "schema_version": "1.0"
}
```

## 6.3 AI Output Contract

```json
{
  "schema_version": "1.0",
  "person": {
    "name": "Sarah Chen",
    "phone": null,
    "email": null,
    "organization": "NAVWAR",
    "context_tag": "Defense"
  },
  "interaction": {
    "date": "2026-08-24",
    "platform": "In Person",
    "summary": "Met Sarah and discussed autonomous mine-detection and data-integration interests."
  },
  "identity": {
    "confidence": 0.87,
    "evidence": ["name supplied by image", "organization supplied by caption"]
  },
  "warnings": []
}
```

Identity confidence is advisory. The application owns the actual match decision, scoped to the requesting owner_id's contacts only. The model must never write a database contact_id, and must never be trusted to know or apply owner_id, unless the application provided that identifier explicitly during a revision task.

## 6.4 FastAPI: POST /revise-draft

```json
{
  "review_id": "uuid",
  "owner_id": "own_...",
  "existing_draft": {...},
  "correction": "We discussed autonomous mine detection, not MCM systems generally.",
  "schema_version": "1.0"
}
```

# 7. Contact Identity Resolution

Contact resolution must be deterministic, application-owned, and strictly scoped to the requesting owner_id. AI extraction supplies evidence; the resolver compares that evidence against the Contacts belonging to the same owner_id as the inbound message — never across users. Owner scoping is applied as a hard filter before any matching logic runs, not as a post-filter on results, so a resolver bug cannot leak one user's candidate matches to another user's review.

- Normalize obvious comparison fields: case-fold names, trim whitespace, normalize phone numbers, lowercase email, and standardize organization aliases where practical.
- Attempt strong-key matches first: exact normalized phone or exact email, within the owner's contacts only.
- Then evaluate composite matches such as normalized name + organization/context tag, within the owner's contacts only.
- Only automatically select a match when confidence exceeds an explicit threshold and no competing candidate is close.
- If uncertain, present the user with numbered candidates (drawn only from their own contacts) plus a "create new contact" option.
- Never merge two contacts automatically, and never merge contacts across two different owner_id values under any circumstance. Contact merging is an explicit future administrative action, scoped to a single owner.

| Resolution result | NRM behavior |
| --- | --- |
| Zero credible matches (within owner's contacts) | Propose a new contact and show the extracted identity with the interaction draft. |
| One high-confidence match (within owner's contacts) | Bind the draft to that contact and request final approval. |
| Multiple or uncertain matches (within owner's contacts) | Enter DISAMBIGUATING and request a numbered choice. |
| Exact phone/email collision | Treat as a data-quality exception within that owner's contacts; do not guess. Never resolved against another owner's data. |

# 8. Local AI Design and Prompting

## 8.1 Model Roles

| Model role | Responsibility |
| --- | --- |
| Text extractor | Interpret plain-language capture; produce schema-valid JSON. |
| Vision-language extractor | Read image evidence and combine it with user caption/context. |
| Revision model | Modify only the relevant draft fields based on user correction while preserving unaffected fields. |

## 8.2 Prompt Hierarchy

- System contract: exact schema, allowed enums, no prose outside JSON, no database writes, no unsupported facts, no owner_id or cross-user reasoning of any kind.
- Application context: current date/time, schema version, known platform hints, and permitted interpretations.
- User caption/instruction: highest-priority semantic guidance for how the image should be interpreted.
- Image contents: evidence source, not authority over contradictory user instructions.

## 8.3 Required Prompt Behaviors

- Use null rather than inventing unavailable fields.
- Flag uncertainty in warnings rather than fabricating precision.
- Do not infer a phone number or email from unrelated image text.
- Use the system-provided current date to resolve relative words such as "today" when appropriate.
- Keep summaries concise, factual, and relationship-relevant.
- Return a schema_version with every response.
- Treat owner_id, if present in the payload, as opaque passthrough only — never as content to reason about or include in generated text.

# 9. Security, Privacy, and Trust Boundaries

NRM contains relationship information and therefore should be designed as a privacy-sensitive system, and more so now that multiple beta users' data lives in one shared store. The architecture should minimize public attack surface, avoid unnecessary cloud exposure of raw relationship data, and guarantee that one user's relationship data is never visible to, or writable by, another user.

| Control | Requirement |
| --- | --- |
| Twilio signature validation | Validate X-Twilio-Signature at the edge before trusting the webhook payload. |
| Authorized-sender → owner map | Maintain an explicit mapping of each authorized beta-tester phone number to its owner_id. Only mapped numbers are accepted; unmapped senders are rejected before any owner_id is assigned. |
| Secrets | Keep Twilio token, tunnel credentials, and internal API secrets outside source control. |
| Worker → Apps Script authentication | Use a shared secret/HMAC or other authenticated internal request mechanism. owner_id is set by the Worker from the verified sender map and is treated as trusted only because the Worker is authenticated. |
| Tunnel | Expose only the FastAPI route through a managed tunnel; do not port-forward the Windows host. |
| FastAPI authentication | Require an internal bearer/HMAC secret for every request. |
| Owner-scoped data access | Every Sheets read/write helper takes owner_id as a required parameter. There is no code path that queries or writes Contacts/Interactions without it. |
| Media retention | Temporarily download only what is needed; delete local transient files after processing unless retention is intentionally enabled. |
| Logging | Never log auth tokens, full secret headers, or unnecessary raw sensitive content. Logs may include owner_id (it is not itself sensitive) to support per-user debugging. |
| Sheet permissions | Restrict access to the Google account(s) that actually require it; the shared Sheet's edit access should be limited to the service account/script, not to beta testers directly. |
| Backups | Maintain periodic export/backups of Contacts and Interactions, including owner_id, so restores preserve tenant boundaries. |

Twilio documents that inbound webhook requests are signed with the X-Twilio-Signature header, and the signature is based on the webhook URL and request parameters using the account auth token. Cloudflare Workers can inspect request headers and implement HMAC verification, making the edge layer a more suitable validation boundary than a bare Apps Script web app — and it is also the natural place to perform the sender-to-owner_id mapping, since it already authenticates the request before anything downstream trusts it.

# 10. Reliability, Idempotency, and Error Handling

## 10.1 Idempotency

- MessageSid must be recorded before processing. A repeated MessageSid must never create a second interaction.
- review_id identifies the workflow; interaction_id identifies the final committed event. They are different identifiers.
- Commit should be written as a guarded operation: verify staging exists, verify not previously committed, verify the resolved contact_id belongs to the same owner_id as the staging row, append Interaction (with owner_id), update Contact derived fields, then clear/archive Staging.

## 10.2 Local Machine Offline

The user-facing system should not discard a capture merely because the local laptop is asleep. PROCESSING remains durable in Staging, with owner_id already attached. The system may report that the item is queued or temporarily unavailable. A retry path can be manual in the first implementation and scheduled/queued in later hardening. A local AI outage affects all beta users simultaneously, so this is an operational concern to monitor once more than one person depends on timely responses, not just a personal inconvenience.

## 10.3 Recommended Error Categories

| Code | Meaning | Disposition |
| --- | --- | --- |
| WEBHOOK_AUTH_FAILED | Untrusted inbound request | Reject; do not create staging. |
| UNAUTHORIZED_SENDER | Sender not in the owner map | Reject or silently acknowledge. |
| DUPLICATE_MESSAGE | MessageSid already seen | No-op. |
| LOCAL_API_UNAVAILABLE | Tunnel/API unreachable | Keep staging; retry. |
| AI_INVALID_JSON | Model violated contract | Retry once with repair strategy; then ERROR. |
| AI_SCHEMA_ERROR | Valid JSON but wrong fields/types | Reject output; retry/ERROR. |
| CONTACT_COLLISION | Resolver found data conflict within the owner's contacts | Require manual disambiguation. |
| OWNER_MISMATCH | Resolved contact_id's owner_id does not match the staging row's owner_id | Hard-reject the commit; log as a critical EventLog entry; never write. |
| COMMIT_FAILURE | Sheet write partially/fully failed | Do not delete staging; log diagnostic state. |

# 11. Development Roadmap

The project should advance through gated stages. Each stage has a deliverable and exit test. Do not begin advanced intelligence features until the prior stage is stable. Multi-user (owner_id) support is introduced at Stage 1, as part of the schema freeze, rather than retrofitted after data exists — this avoids a migration and avoids the risk of early rows lacking a tenant boundary.

## Stage 0 — Repository, Configuration, and Design Freeze

- Create a dedicated NRM repository and document environment variables, deployment targets, and naming conventions.
- Create a CONFIG sheet or script-properties strategy for non-secret runtime configuration; secrets belong in platform secret stores/script properties, never in the spreadsheet body.
- Freeze schema version 1.0 for Contacts, Interactions, Staging, and EventLog, including owner_id on all four.
- Define platform enum values and state enum values.
- Define the initial authorized-sender → owner_id map for the beta group.
- Archive the current prototype as legacy/reference rather than modifying it in place.

**Exit gate: repository runs locally, schema (including owner_id) is documented, and the legacy command-parser implementation is no longer considered the active code path.**

## Stage 1 — Google Sheets Database Foundation

- Create Contacts, Interactions, Staging, and EventLog tabs with exact headers, including owner_id.
- Add stable IDs rather than using names as keys.
- Implement Sheets.gs helpers: findContactById, searchContacts, appendInteraction, create/update/delete staging, event logging — every helper takes owner_id as a required parameter.
- Add deterministic date formatting and normalization utilities.
- Create test data covering duplicate names, missing phone/email, multiple contexts, and at least two distinct owner_id values to verify isolation.

**Exit gate: unit-style Apps Script test functions can create/read/update staging and append an interaction without Twilio or AI, and a test asserting cross-owner isolation (owner A cannot read/match owner B's contacts) passes.**

## Stage 2 — FastAPI Skeleton with Dummy Responses

- Create the Windows-side FastAPI project.
- Implement /health, /process-interaction, and /revise-draft, all accepting and echoing owner_id.
- Return deterministic dummy JSON that conforms exactly to schema_version 1.0.
- Add request authentication and structured logging.
- Run locally first; then expose through Cloudflare Tunnel.

**Exit gate: a controlled request from Apps Script reaches FastAPI through the tunnel and receives validated JSON.**

## Stage 3 — Apps Script State Machine

- Replace parseIncomingSMS and addOrUpdateContact with normalized, owner_id-aware event routing.
- Implement PROCESSING, DISAMBIGUATING, PENDING_REVIEW, REVISING, and ERROR handlers.
- Implement candidate-number parsing and YES approval logic, scoped to the owner's own candidates.
- Implement guarded commit into Contacts + Interactions, including the OWNER_MISMATCH check.
- Add MessageSid duplicate checks and revision_count.

**Exit gate: the full review loop works against dummy FastAPI responses without any AI model, for at least two concurrent test owners without cross-contamination.**

## Stage 4 — Twilio Integration, Initially Minimal

- Configure inbound Twilio webhook against a controlled endpoint.
- Parse Body, From, To, MessageSid, NumMedia, MediaUrlN, and MediaContentTypeN.
- Add authorized-sender enforcement via the owner map.
- Use Twilio outbound API or TwiML appropriately for review replies.
- Validate text-only workflows end-to-end for at least two beta phone numbers.

**Exit gate: real SMS can create a staged draft, disambiguate, revise, approve, and commit exactly once, correctly attributed to the sending owner.**

## Stage 5 — Secure Edge Gateway

- Place a Cloudflare Worker in front of the webhook.
- Validate Twilio signature using the exact webhook URL and request parameters before forwarding.
- Resolve the verified sender number to owner_id using the authorized-sender map.
- Normalize and authenticate the request sent downstream, including the resolved owner_id.
- Return/acknowledge Twilio quickly rather than coupling Twilio response time to local AI inference.
- Add edge-level rejection logging without exposing secrets.

**Exit gate: direct unauthenticated requests cannot reach the trusted orchestration path, unmapped senders are rejected, and valid Twilio requests continue to work with the correct owner_id attached.**

## Stage 6 — Local Text LLM Integration

- Connect FastAPI to Ollama, LM Studio, or another local inference runtime.
- Implement strict JSON schema validation in Python; do not trust raw model output.
- Add one controlled repair retry for malformed output.
- Create a regression set of representative NRM messages.
- Measure extraction quality for names, dates, platforms, organizations, and summaries.

**Exit gate: text-only captures pass the regression set at an acceptable accuracy level and malformed model outputs cannot corrupt Sheets.**

## Stage 7 — Vision/MMS Integration

- Download Twilio media securely and temporarily when required.
- Route text+image and image-only requests to the VLM.
- Prioritize user caption/instruction when it conflicts with irrelevant image text.
- Handle business cards, contact screenshots, event screenshots, and representative photos.
- Delete transient media after inference unless explicit retention is enabled.

**Exit gate: representative MMS inputs produce correct structured drafts and do not leave uncontrolled media artifacts on disk.**

## Stage 8 — Identity Resolver Hardening

- Implement strong-key and composite matching rules, hard-scoped to owner_id.
- Create confidence thresholds outside the model.
- Add zero-match new-contact proposals.
- Add data-collision and ambiguous-contact test cases, including cross-owner collision cases that must never match.
- Prevent automatic merges, and specifically prevent any merge path from crossing owner_id.

**Exit gate: the resolver is predictable across duplicate names, organization/context changes, and incomplete evidence, and never returns a candidate from a different owner_id.**

## Stage 9 — Reliability and Recovery

- Add retry controls for LOCAL_API_UNAVAILABLE and transient inference failures.
- Add stale PROCESSING detection.
- Add administrative recovery functions: retryReview(review_id), cancelReview(review_id), inspectReview(review_id) — all owner_id-scoped for the operator.
- Add periodic backup/export of Contacts and Interactions, including owner_id.
- Introduce a durable queue only if real usage demonstrates the need; Cloudflare Queues or another lightweight job queue is a later hardening option.

**Exit gate: unplugging/rebooting the local machine during a capture does not lose or duplicate the interaction, for any beta user. This is the recommended minimum bar before the beta group relies on the system.**

## Stage 10 — Operational Polish

- Replace raw error messages with concise user-facing SMS responses.
- Add summary metrics such as pending jobs and recent failures, breakable down by owner_id for support purposes.
- Add data validation/dropdowns in Sheets for status/platform fields.
- Create a maintenance checklist for credentials, tunnel health, backups, model upgrades, and onboarding/offboarding a beta tester (adding/removing an owner map entry).
- Document upgrade/migration procedure for schema_version changes.

**Exit gate: NRM is maintainable without reading source code for ordinary operations, including adding or removing a beta tester.**

## Stage 11 — Controlled Intelligence Expansion

- Only after a substantial body of trustworthy interactions exists, evaluate embeddings and semantic retrieval, scoped per owner_id.
- Build retrieval over Interactions while keeping Contacts authoritative for identity, never crossing owner boundaries.
- Add queries such as "What did I last discuss with Jane?" and "Who do I know at organization X?", always scoped to the asking user.
- Consider relationship briefs, pre-meeting context, reconnect prioritization, and network exploration.
- Add proactive features only with clear user control and explainable source interactions.

**Exit gate: advanced features demonstrate clear value on real NRM data without weakening privacy or data integrity, and without ever surfacing one user's data to another.**

# 12. Test Strategy

## 12.1 Minimum End-to-End Test Matrix

| Test | Expected result |
| --- | --- |
| Text-only, existing unique contact | Draft binds to correct contact; YES commits once. |
| Text-only, new person | New-contact proposal + interaction review. |
| Duplicate name | DISAMBIGUATING list appears; numbered choice binds correct contact. |
| Correction after draft | REVISING produces new draft; original is not committed. |
| Repeated Twilio webhook | MessageSid dedupe prevents duplicate staging/interaction. |
| MMS business card + caption | VLM extracts identity; caption guides interaction context. |
| Image-only capture | System produces usable draft or asks for clarification through review—not silent fabrication. |
| Laptop offline | Capture remains recoverable; no interaction loss. |
| Malformed model JSON | Schema validator blocks write. |
| Unauthorized sender | No CRM mutation. |
| Commit failure | Staging remains recoverable and EventLog records failure. |
| Two beta users, same person's name, same day (New) | Two separate contacts are created, one per owner_id; neither user's resolver sees the other's candidate. |
| Owner A's message resolved against Owner B's contact_id (fault injection) | COMMIT_FAILURE / OWNER_MISMATCH is raised; no write occurs; EventLog records a critical entry. |

## 12.2 Regression Corpus

Create a small, version-controlled collection of synthetic NRM captures and expected JSON. Every prompt/model change should rerun this set. Include ambiguous dates, nicknames, duplicate names, missing organizations, noisy screenshots, corrections that change only one field, and at least two synthetic owner_id values so cross-tenant regressions are caught automatically.

# 13. Recommended Codebase Organization

```
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
│   ├── src/index.ts
│   ├── src/owner-map.ts
│   └── wrangler.jsonc
├── local-api/
│   ├── app/main.py
│   ├── app/models.py
│   ├── app/routes.py
│   ├── app/inference.py
│   ├── app/media.py
│   ├── app/security.py
│   └── tests/
└── legacy/
    └── original_apps_script.gs
```

The Worker gains a dedicated owner-map module (src/owner-map.ts) since sender→owner_id resolution is a discrete, security-relevant responsibility distinct from signature verification and event normalization.

# 14. Disposition of the Existing Prototype

The current Apps Script should be archived, not incrementally extended. It is a useful proof that Twilio can reach Apps Script and Sheets, but its fundamental abstraction is different: it treats SMS as a structured database command rather than a source interaction requiring interpretation, review, and — now — owner attribution.

| Existing element | Disposition |
| --- | --- |
| doPost(e) | Replace with owner-aware state-machine router. |
| parseIncomingSMS(text) | Retire completely. Natural-language interpretation moves to local AI. |
| addOrUpdateContact(...) | Retire. Replace with owner-scoped Contact/Interaction persistence helpers. |
| parseDateSafely(...) | Concept may be retained in Utils with stricter validation. |
| findPersonToReconnect() | Reimplement later against Contacts/Interactions, scoped per owner_id. |
| dailyReconnectReminder() | Defer until core capture pipeline is stable. |
| refreshPivotTables() | Remove from core pipeline. Analytics belongs outside ingestion. |

# 15. Representative User Workflows

## 15.1 Existing Contact, Text Only

- User texts a natural-language interaction to the NRM number.
- Twilio forwards the signed webhook to the Worker.
- Worker validates, normalizes, resolves the sender to owner_id, acknowledges, and forwards the trusted event.
- Apps Script creates review_id and PROCESSING staging record under that owner_id.
- FastAPI extracts JSON.
- Resolver finds one strong contact match within that owner's contacts.
- NRM sends PENDING_REVIEW summary.
- User replies YES.
- Interaction is appended with owner_id; Contact last_contact/last_platform are updated; staging is cleared.

## 15.2 Ambiguous Contact

- Resolver identifies multiple Sarah Chen records within the sending user's own contacts.
- NRM sends a numbered list containing context tags and a "create new" option.
- User replies with the number.
- Draft is bound to the chosen contact and returned for final review.

## 15.3 Correction Loop

- User receives draft but replies with a correction instead of YES.
- State changes to REVISING and the existing draft + correction (with owner_id) are sent to /revise-draft.
- Validated revised JSON replaces draft_json and revision_count increments.
- State returns to PENDING_REVIEW. Nothing permanent is written until YES.

## 15.4 Two Beta Users, Overlapping Names

- Two different beta testers each separately text about someone named "Sarah Chen" on the same day.
- Each message is resolved to a different owner_id at the edge, based on the sending phone number.
- Each resolver run only ever sees its own owner's Contacts; neither tester's candidate list includes the other's Sarah Chen.
- Two independent contacts (and, if approved, two independent interactions) are created, each correctly owner-scoped.

# 16. Definition of Done for NRM v1

NRM v1 should be considered complete only when the following conditions are simultaneously true:

- A user can capture an interaction with ordinary language rather than command syntax.
- Text, image, and multimodal inputs traverse the same staged review model.
- Contacts and interaction history are preserved separately.
- All permanent interaction writes are human-approved.
- Duplicate Twilio deliveries cannot duplicate CRM records.
- A local-AI outage does not silently lose the capture for any beta user.
- A model cannot bypass schema validation or choose a database identity unilaterally.
- Ambiguous identities are resolved explicitly.
- Security controls reject untrusted webhook traffic and unauthorized senders.
- Every Contact, Interaction, Staging, and EventLog row carries a correct owner_id, and no code path can read or write across owner_id boundaries.
- At least two distinct beta users can use the system concurrently with demonstrated data isolation between them.
- Operational failures are visible in EventLog and recoverable from Staging.
- The system can be maintained and backed up using documented procedures, including adding or removing a beta tester.

# 17. Post-v1 Expansion Roadmap

## 17.1 Retrieval and Relationship Briefs

Once the interaction corpus is trustworthy, NRM can build summaries across history: last discussion, recurring themes, open follow-ups, and a pre-meeting brief — always scoped to the requesting owner_id. At this stage, embeddings or RAG may become justified.

## 17.2 Network Search

Examples: "Who do I know at NAVWAR?", "Which contacts have discussed data integration?", "Who have I not spoken with in six months?", and "Show people connected to mine countermeasures or autonomous systems." All scoped to the asking user's own contacts.

## 17.3 Reconnect Prioritization

The existing reconnect-reminder idea can later become more intelligent by considering recency, relationship category, unresolved follow-ups, and user-defined importance rather than simply selecting the largest Days Since value — computed independently per owner_id.

## 17.4 Additional Ingestion Channels

Email, calendar, contacts, LinkedIn exports, or other sources may later feed NRM, but each new channel should enter through the same normalized evidence → extraction → owner-scoped identity resolution → review → commit contract unless the user explicitly chooses a trusted automated mode.

## 17.5 Multi-Tenant Scale-Up

Because the owner_id boundary is established at the schema level from Stage 1 onward, scaling beyond the initial beta group is expected to be an operational change (extend the authorized-sender map, consider migrating Sheets to a proper database once row counts or concurrent-write volume justify it) rather than a data-model redesign.

# 18. Architectural Decision Log

| Decision | Status | Reason |
| --- | --- | --- |
| Rename project to Network Resource Management (NRM) | Approved | Reflects broader relationship/network utility beyond a traditional personal CRM. |
| Separate Contacts from Interactions | Approved | Preserves relationship history and enables future retrieval. |
| Use immutable IDs | Approved | Names are ambiguous and mutable. |
| Use Staging state machine | Approved | Supports disambiguation, revision, retry, and auditability. |
| Add PROCESSING and ERROR states | Approved | Local AI is not guaranteed to be immediately available. |
| Use MessageSid for idempotency | Approved | Protects against duplicate webhook deliveries. |
| Secure edge gateway before Apps Script | Approved | Allows proper request-header inspection/signature validation. |
| Keep Apps Script orchestration for MVP | Approved | Maintains simple integration with Google Sheets. |
| Local FastAPI behind Cloudflare Tunnel | Approved | Provides a stable private AI boundary. |
| Human approval before commit | Approved | Preserves trust and prevents AI data corruption. |
| Application-owned identity resolution | Approved | Database identity is a deterministic business rule, not an LLM decision. |
| Multi-tenant: shared data store with owner_id-tagged rows | Approved | Scales to additional beta users without per-user infrastructure, and supports future cross-cutting/batch processing; chosen over per-user Sheets and over a single shared network. |
| Owner resolution performed at the edge (Worker), not in Apps Script or the AI layer | Approved | Keeps tenant attribution in the same authenticated boundary as signature verification; AI models never see or reason about owner_id. |
| Defer RAG/vector DB/dashboard | Approved | Avoids feature creep before data quality and capture reliability are proven. |
| Durable queue at day one | Deferred | Useful hardening option, but not required to validate the MVP. |
| Per-user Sheets/isolated infrastructure | Rejected | Multiplies operational and deployment overhead per user and blocks future cross-cutting features; shared owner-scoped store chosen instead. |
| Single shared network visible to all beta users | Rejected | Conflates distinct users' private relationship data; not consistent with NRM's purpose as personal relationship memory. |
| Outbound SMS via synchronous TwiML reply | Superseded | Stage 5's fast-acknowledgement Worker design means Apps Script's reply can no longer reach Twilio via the original webhook response; outbound replies now use Twilio's REST Messages API as a separate authenticated call. |
| Owner map location: Apps Script Script Property vs. Worker source file | Resolved to Worker | Stage 4 initially used a temporary Apps Script Script Property (NRM_AUTHORIZED_SENDERS_JSON) since the Worker did not yet exist. Stage 5 moved authorization to worker/src/owner-map.ts per original design; the Script Property is now obsolete. |

# 19. Immediate Next Build Sequence

*(Historical — reflects the plan at document authoring time, before Stages 0-5 were implemented. Retained for reference; see repository commit history and docs/architecture.md for what was actually built.)*

The next development work should begin at Stage 0 and Stage 1, not with AI model selection. The recommended order for the next coding session is:

- Archive the original Apps Script as legacy/original_apps_script.gs.
- Create the four Google Sheet tabs with frozen v1 headers, including owner_id on Contacts, Interactions, Staging, and EventLog.
- Define the initial authorized-sender → owner_id map for yourself and the beta group.
- Create new Apps Script files and implement configuration/constants.
- Implement the Sheets.gs persistence helpers (all owner_id-scoped) and local test functions, including a cross-owner isolation test.
- Create the FastAPI skeleton with /health and dummy /process-interaction responses that accept and echo owner_id.
- Only after those pass, implement the Apps Script state machine against the dummy API.

**Do not connect a real LLM until the state machine, review loop, owner-scoped persistence model, and cross-tenant isolation work correctly with deterministic dummy responses.**

# 20. Implementation References

These are implementation references for the technologies in the approved architecture. They are not a substitute for NRM-specific tests and security review.

- Twilio Messaging Webhooks: https://www.twilio.com/docs/usage/webhooks/messaging-webhooks
- Twilio Webhooks Security: https://www.twilio.com/docs/usage/webhooks/webhooks-security
- Cloudflare Workers Webhooks / signature verification patterns: https://developers.cloudflare.com/agents/communication-channels/webhooks/
- Cloudflare Workers request signing example: https://developers.cloudflare.com/workers/examples/signing-requests/
- Google Apps Script Web Apps: https://developers.google.com/apps-script/guides/web

# Appendix A — Recommended Google Sheet Headers

## Contacts

contact_id | owner_id | display_name | context_tag | phone | email | organization | role_title | relationship_summary | last_contact | last_platform | created_at | updated_at | status

## Interactions

interaction_id | contact_id | owner_id | interaction_date | platform | summary | details_json | raw_body | media_refs | source_message_sid | created_at | ai_model | schema_version

## Staging

review_id | message_sid | owner_number | owner_id | state | created_at | updated_at | raw_body | media_json | candidate_contact_ids | selected_contact_id | draft_json | revision_count | error_json

## EventLog

event_id | review_id | owner_id | timestamp | event_type | status | details

# Appendix B — Suggested Enums

| Category | Initial values |
| --- | --- |
| Workflow state | PROCESSING; DISAMBIGUATING; PENDING_REVIEW; REVISING; ERROR |
| Contact status | ACTIVE; ARCHIVED; MERGED |
| Platform | IN_PERSON; TEXT; CALL; EMAIL; LINKEDIN; INSTAGRAM; EVENT; VIDEO_CALL; OTHER |
| Event status | SUCCESS; RETRY; FAILURE |

# Appendix C — Owner / Tenant Model Summary

Added to support a small beta group rather than a single user.

- owner_id is the single multi-tenancy boundary in NRM. It is resolved once, at the edge (Cloudflare Worker), from the verified inbound sender's phone number against an explicit authorized-sender map.
- owner_id is propagated unchanged through Staging → FastAPI (passthrough only) → identity resolution → Contacts/Interactions/EventLog. No component downstream of the Worker re-derives it.
- All Sheets persistence helpers require owner_id as a parameter; there is no "global" read or write path.
- Identity resolution, disambiguation candidates, and merges are always scoped to a single owner_id; cross-owner matching or merging is explicitly disallowed.
- The AI models (LLM/VLM) never reason about owner_id — they treat it as opaque passthrough, keeping tenant logic entirely in deterministic application code.
- This model was chosen over per-user Sheets (too much per-user operational overhead to scale) and over a single shared network (would conflate different users' private relationship data), because it scales to more beta users and to later batch/cross-cutting processing with only a data-store migration, not a schema redesign.
