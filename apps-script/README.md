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
