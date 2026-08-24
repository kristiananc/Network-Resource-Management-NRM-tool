# NRM Stage 0 Test-Case Contract

Stage 0 does not implement runtime tests yet. This document freezes the minimum scenarios later stages must cover so the architecture is tested against the intended multi-user behavior from the beginning.

## Tenant-isolation cases

1. **Same name, different owners**  
   Owner A and Owner B each have a contact named Sarah Chen. A search for Owner A must never return Owner B's record, and vice versa.

2. **Same phone/email, different owners**  
   Strong-key matching remains owner-scoped. Identical normalized contact fields across owners are not collisions with each other.

3. **Fault-injected cross-owner contact_id**  
   A staged review for Owner A is deliberately paired with a `contact_id` belonging to Owner B. Later commit logic must hard-fail with an owner mismatch and perform no permanent write.

4. **Candidate-list isolation**  
   Ambiguous-contact candidates for one owner contain only contact IDs belonging to that owner.

5. **Owner passthrough**  
   Downstream components receive the `owner_id` set by the Worker and do not derive a replacement from `owner_number`, contact data, AI output, or another field.

## Persistence/idempotency cases reserved for later stages

- duplicate Twilio `MessageSid` does not create duplicate staging or interaction rows;
- commit writes an Interaction exactly once;
- commit failure leaves recoverable Staging data;
- local API outage does not lose a capture;
- malformed AI JSON cannot reach permanent persistence;
- revision does not commit the original draft;
- unauthorized sender causes no CRM mutation.

## Stage 1 minimum fixture recommendation

When executable Apps Script tests are added, create synthetic fixtures with at least two owner IDs, for example:

```text
own_beta_001
own_beta_002
```

Include duplicate names and overlapping contact details across those owners so isolation is continuously exercised rather than tested only as a special case.
