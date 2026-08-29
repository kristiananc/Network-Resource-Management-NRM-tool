# NRM Apps Script

Stage 1 provides the owner-scoped Google Sheets persistence foundation. It
does not implement Twilio, AI, FastAPI, or Worker behavior.

## Provision the four tabs

Production and deployed web-app executions use the required Script Property
`NRM_SPREADSHEET_ID` and open that spreadsheet explicitly. They never depend on
`SpreadsheetApp.getActiveSpreadsheet()`.

After adding the files in this directory to the Google Apps Script project,
run this one-time function from the Apps Script editor:

```javascript
setupNrmProductionSpreadsheet();
```

If the project is bound to a Google Sheet, the function adopts that parent. If
the project is standalone, it creates a spreadsheet named `NRM Production`.
If `NRM_SPREADSHEET_ID` is already configured, it opens that existing file.
In every case it provisions the four schema tabs and logs output in this form:

```text
NRM production spreadsheet source: bound spreadsheet
NAME: Network Resource Management
ID: 1exampleSpreadsheetId
URL: https://docs.google.com/spreadsheets/d/1exampleSpreadsheetId/edit
SCRIPT PROPERTY: NRM_SPREADSHEET_ID=1exampleSpreadsheetId
```

The helper automatically sets `NRM_SPREADSHEET_ID` when adopting or creating a
file. Copy the logged URL to open the production database directly. To point at
a pre-existing different file instead, set `NRM_SPREADSHEET_ID` manually under
Project Settings → Script Properties, then run:

```javascript
setupNrmSheets();
```

The function creates missing `Contacts`, `Interactions`, `Staging`, and
`EventLog` tabs with the exact schema v1.0 headers from `docs/schemas.md`. It
initializes an existing empty tab, but refuses to overwrite a non-empty tab
whose headers do not match the frozen schema.

The test suites explicitly override the spreadsheet selector with temporary
files; they do not read or write the production ID.

## Run the Apps Script tests

From the Apps Script editor, run:

```javascript
runStage1Tests();
```

For only the tenant-boundary check, run:

```javascript
runCrossOwnerIsolationTest();
```

Each test function creates an isolated temporary spreadsheet, logs its result,
and moves the temporary spreadsheet to trash in a `finally` block. The tests do
not write fixtures into the active production spreadsheet.

The same functions can be exercised locally against the in-memory Apps Script
test adapter:

```shell
node apps-script/tests/run-stage1-tests.js
```

## Stage 3 normalized event routing

Stage 3 exposes `handleNormalizedEvent(event)`. It accepts an authenticated,
normalized event object containing `message_sid`, `owner_id`, `owner_number`,
`body`, and optional `review_id`, `media_refs`, `contact_query`, and `contact`
fields. It does not parse Twilio webhook form data or legacy command strings.

Set `NRM_LOCAL_API_BASE_URL` and `NRM_INTERNAL_API_TOKEN` in Apps Script Script
Properties before using the real Stage 2 client. The token must not be placed
in a sheet or committed file.

Run the Stage 3 Apps Script suite with:

```javascript
runStage3Tests();
```

Run only the concurrent two-owner loop with:

```javascript
runStage3CrossOwnerLoopTest();
```

The local regression runner uses a deterministic Stage 2-compatible dummy
client and does not require Twilio, a Worker, a Tunnel, or a live LLM:

```shell
node apps-script/tests/run-stage3-tests.js
```

With the Stage 2 Uvicorn server already running locally, the Node adapter can
also exercise the production Apps Script client contract over real HTTP:

```shell
NRM_STAGE3_LIVE_FASTAPI=1 \
NRM_LOCAL_API_BASE_URL=http://127.0.0.1:8765 \
NRM_INTERNAL_API_TOKEN=replace-with-the-running-server-token \
  node apps-script/tests/run-stage3-tests.js
```

## Stage 5 Worker-authenticated webhook adapter

Stage 5 removes the temporary direct-Twilio production path. `doPost(e)` now
accepts only a JSON envelope signed by the Cloudflare Worker with HMAC-SHA256.
It verifies the HMAC and a five-minute timestamp window before decoding the
normalized event, trusting `owner_id`, or creating workflow state. Direct
Twilio form posts, malformed envelopes, changed payloads, and stale envelopes
return empty valid TwiML and create no trusted Staging or EventLog state.

The Apps Script web-app URL remains:

```text
https://script.google.com/macros/s/AKfycbwlXlbdv2n8gI4oEqApVCmrxOgutpX2KkRG_5wZaleK45LPaBWcaP26-bDgRThiN_Iz/exec
```

Set `NRM_WORKER_HMAC_SECRET` under Project Settings → Script Properties to the
same long random secret stored as the Cloudflare Worker secret. Apps Script
does not receive arbitrary request headers in `doPost(e)`, so the Worker signs
`<timestamp>.<base64-payload>` and places the timestamp, payload, and signature
in the JSON body.

`NRM_AUTHORIZED_SENDERS_JSON` is obsolete and can be removed. Sender
authorization and owner resolution now exist only in
`worker/src/owner-map.ts` after Twilio signature validation.

Apps Script sends state-machine replies asynchronously through Twilio's REST
Messages API. Add these two additional Script Properties:

- `TWILIO_ACCOUNT_SID`: the Twilio Account SID used in the Messages endpoint
  and as the HTTP Basic Auth username.
- `TWILIO_AUTH_TOKEN`: that account's Auth Token, used as the HTTP Basic Auth
  password. This is a separate platform copy from the Worker's secret.

The outbound request posts form-encoded `To`, `From`, and `Body` fields to:

```text
https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json
```

`To` is the original verified sender, `From` is the Twilio number that received
the inbound SMS, and `Body` is the existing disambiguation, review, error, or
commit-confirmation text. Send failures are logged as `OUTBOUND_SMS_FAILED`
without phone numbers, message text, or credentials and do not change workflow
state. Twilio trial accounts can send only to verified recipient numbers.

Run the local Stage 1 + Stage 3 regressions and Stage 5 Apps Script gateway
suite:

```shell
node apps-script/tests/run-stage4-tests.js
```

Run the Stage 5 Apps Script suite in the Apps Script editor with:

```javascript
runStage5AppsScriptTests();
```

**Redeployment is mandatory after every Apps Script code change.** Saving code
does not update the active `/exec` deployment. Use **Deploy → Manage
deployments → active deployment → Edit → New version → Deploy**. Updating the
existing deployment preserves its URL. Worker changes separately require
`cd worker && npm run deploy`.

The Worker still acknowledges Twilio immediately with empty TwiML. Apps Script
does not depend on that response channel; it sends the generated reply as a new
outbound Message through Twilio's REST API.
