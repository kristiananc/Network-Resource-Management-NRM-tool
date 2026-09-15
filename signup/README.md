# NRM signup page

This directory is a static GitHub Pages signup form. It posts only to the
separate access-request Apps Script web app in `access-request-apps-script/`.
It must never point at the existing Twilio-facing Apps Script deployment.

After deploying the access-request web app, replace the placeholder in
`config.js` with its `/exec` URL, then commit and push that one configuration
change. The production page URL is expected to be:

```text
https://kristiananc.github.io/Network-Resource-Management-NRM-tool/signup/
```

The submission uses a hidden iframe rather than `fetch(..., {mode: "no-cors"})`.
That lets the Apps Script response send a genuine success or error acknowledgement
back to the page with `postMessage`; an opaque `no-cors` response cannot prove
that the row was accepted.

## Enable GitHub Pages

After `config.js` contains the separate access-request `/exec` URL:

1. Open the repository on GitHub and select **Settings**.
2. Under **Code, planning, and automation**, select **Pages**.
3. Under **Build and deployment → Source**, select **Deploy from a branch**.
4. Select branch **main** and folder **/(root)**, then select **Save**.
5. Wait for the GitHub Pages deployment shown in the repository's Actions tab
   to complete, then open the production URL above.

## Local checks

From the repository root:

```shell
node --test signup/test-signup.mjs
node access-request-apps-script/tests/run-tests.js
```
