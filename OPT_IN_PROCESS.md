# NRM Opt-In Process

Last updated: September 22, 2026

NRM is a private personal relationship-management tool. Prospective users request access by visiting the [NRM signup page](https://kristiananc.github.io/Network-Resource-Management-NRM-tool/signup/) and providing their name and phone number. They may separately and optionally check a consent box to opt into automated SMS/MMS messages from NRM. The access-request form can be submitted without checking that box.

Submitted requests are reviewed individually by the account owner. The stored `sms_consent` value must be checked during that review. A request with `sms_consent=false` must never be added to the Cloudflare Worker's owner map and must not be authorized to receive NRM SMS/MMS messages. Only a manually reviewed request with `sms_consent=true` may be authorized.

Users can reply **STOP** at any time to unsubscribe and stop receiving messages.

The signup page above is the sole method of requesting access; there is no automatic or self-service enrollment, and every request is manually reviewed and approved. NRM does not conduct cold outreach and does not use purchased contact lists.
