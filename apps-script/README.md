# NRM Apps Script — Stage 1

Stage 1 provides the owner-scoped Google Sheets persistence foundation. It
does not implement Twilio, AI, FastAPI, or Worker behavior.

## Provision the four tabs

Add the files in this directory to a Google Apps Script project, then run:

```javascript
setupNrmSheets();
```

The function creates missing `Contacts`, `Interactions`, `Staging`, and
`EventLog` tabs with the exact schema v1.0 headers from `docs/schemas.md`. It
initializes an existing empty tab, but refuses to overwrite a non-empty tab
whose headers do not match the frozen schema.

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
