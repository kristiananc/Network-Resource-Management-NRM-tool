# NRM Cloudflare Worker — Stage 5 Secure Edge Gateway

The Worker is the only production ingress for Twilio. It validates Twilio's
signature against the exact configured webhook URL and all form parameters,
maps the verified `From` value to an opaque `owner_id`, normalizes the event,
and forwards an HMAC-authenticated JSON envelope to Apps Script.

The Worker returns empty TwiML immediately and puts the Apps Script fetch in
`ctx.waitUntil()`. Apps Script processing therefore does not delay Twilio's
acknowledgement. The Apps Script response is not relayed to Twilio; Apps Script
instead sends generated review and confirmation text as a separate outbound
message through Twilio's REST Messages API.

`waitUntil()` has a finite background-execution window. If Apps Script work can
exceed that window or durable retry becomes necessary, move the normalized
event onto Cloudflare Queues and consume it separately instead of extending
the synchronous Twilio request.

## Normalized event

The authenticated envelope contains a base64-encoded UTF-8 JSON payload with
this shape:

```json
{
  "message_sid": "SM...",
  "owner_id": "own_beta_001",
  "from": "+12025550101",
  "to": "+12025550999",
  "body": "Met Sarah for coffee.",
  "num_media": 1,
  "media": [
    {
      "url": "https://api.twilio.com/example",
      "content_type": "image/jpeg"
    }
  ],
  "received_at": "2026-08-28T19:20:21.000Z"
}
```

The request body sent to Apps Script is:

```json
{
  "timestamp": "1787944821",
  "payload": "base64-encoded-normalized-event",
  "signature": "lowercase-HMAC-SHA256-hex"
}
```

The signing input is `<timestamp>.<payload>`. Apps Script rejects invalid or
older-than-five-minute envelopes before trusting `owner_id` or creating
workflow state. The authentication data is in the body because Apps Script
web-app event objects do not expose arbitrary inbound HTTP headers.

## Configure locally

Copy `.dev.vars.example` to the ignored `.dev.vars` file and replace every
placeholder. Do not commit `.dev.vars`.

Replace the placeholder entries in `src/owner-map.ts` with the real authorized
E.164 sender numbers and opaque owner IDs before deployment.

Run:

```shell
cd worker
npm ci
npm run check
```

## Production configuration

Configure these as Cloudflare Worker secrets:

- `TWILIO_AUTH_TOKEN`
- `NRM_WORKER_HMAC_SECRET`

`APPS_SCRIPT_WEB_APP_URL` is a non-secret Worker variable in `wrangler.jsonc`
and points to the active Apps Script `/exec` URL. Update it in source before
deploying if the Apps Script deployment URL changes.

The Twilio validator uses `request.url` exactly as received by the Worker,
including its scheme, host, path, query string, and encoding. Configure that
identical HTTPS URL in Twilio; do not sign or test against a reconstructed or
decoded variant.

Set the identical `NRM_WORKER_HMAC_SECRET` value in Apps Script under Project
Settings → Script Properties. `NRM_AUTHORIZED_SENDERS_JSON` is obsolete in
Stage 5 and can be removed; Apps Script no longer reads it.

## Deployment — required after every change

**Worker:** after any change to Worker code, `owner-map.ts`, configuration, or
bindings, run `cd worker && npm run deploy`. A local save does not update the
deployed Worker. Secret changes made with `wrangler secret put` create and
deploy a new Worker version immediately; Dashboard variable/secret changes
must be followed by **Deploy**.

**Apps Script:** after changing any `.gs` file, saving the editor is not
enough. Open **Deploy → Manage deployments**, select the active web-app
deployment, click **Edit**, select **New version**, and click **Deploy**. This
updates the existing `/exec` URL without changing its deployment ID.

Only after both deployments are current, configure Twilio's inbound Messaging
webhook as HTTP `POST` to the exact Worker URL. Twilio must no longer point
directly at Apps Script.

## Cloudflare Tunnel recommendation (research only)

Do not use a Quick Tunnel for the durable NRM path. Create a remotely managed,
named tunnel in Cloudflare Zero Trust and install `cloudflared` on the machine
running FastAPI. Add a published-application route such as
`nrm-api.example.com` with service URL `http://localhost:8000`, matching the
Stage 2 Uvicorn bind port.

When that deployment is authorized in a later stage:

1. Keep Uvicorn bound to `127.0.0.1:8000`.
2. Run `cloudflared` persistently on the same machine.
3. Set Apps Script `NRM_LOCAL_API_BASE_URL` to the tunnel's HTTPS hostname.
4. Keep `NRM_INTERNAL_API_TOKEN` synchronized with the local API secret.
5. Add Cloudflare Access service-token protection before treating the hostname
   as production-ready; Apps Script will need to send the corresponding Access
   headers in addition to its existing FastAPI bearer token.

The tunnel is not implemented in Stage 5. The local machine must be awake,
online, running FastAPI, and connected to Cloudflare for the route to work.
