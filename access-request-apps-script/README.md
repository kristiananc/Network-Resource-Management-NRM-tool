# NRM access-request Apps Script web app

This is a **separate Apps Script project and deployment** for public signup
requests. Do not add these files to the existing Twilio-facing Apps Script
project, do not replace its `doPost`, and do not reuse its deployment.

## Configure and deploy

1. Create a new standalone Apps Script project named `NRM Access Requests`.
2. Add `Code.gs`, `Tests.gs`, and `appsscript.json` from this directory.
3. Under **Project Settings → Script Properties**, set `NRM_SPREADSHEET_ID` to
   the same production spreadsheet ID used by the main NRM Apps Script project.
4. Run `setupNrmAccessRequestSheet()` once. In the execution log, confirm that
   `NAME`, `ID`, and `URL` identify the intended `NRM Production` spreadsheet
   and that `SHEET EXISTS: true` is printed. This creates the `AccessRequests`
   tab and frozen headers if the tab does not exist; it does not append a request.
5. Run `runAccessRequestTests()` once and confirm all four tests pass. The
   suite uses temporary spreadsheets and does not touch production.
   Passing this suite alone does not prove that `NRM_SPREADSHEET_ID` is set,
   which is why step 4 is required.
6. Choose **Deploy → New deployment → Web app**.
7. Set **Execute as** to **Me** and **Who has access** to **Anyone**. Authorize
   spreadsheet access when prompted, then deploy.
8. Copy the new deployment's `/exec` URL. It must be different from the
   existing Twilio-facing Apps Script URL.
9. Put the new URL in `signup/config.js`, commit, and push that change.

The first valid submission creates an `AccessRequests` tab in the configured
production spreadsheet with these exact headers:

```text
request_id | name | phone_number | consented_at | status
```

Every new request receives an Apps Script UUID, an Apps Script server timestamp,
and status `PENDING`. The endpoint requires an affirmative `consent=yes` value
and an E.164 phone number before it writes anything.

After any endpoint code change, deploy a **new version of this separate web
app**. Saving code alone does not update its `/exec` deployment.

To inspect the target later without creating a tab, run
`logNrmAccessRequestSpreadsheetTarget()`. It logs the production spreadsheet
name, ID, URL, configured property, and whether `AccessRequests` exists.
