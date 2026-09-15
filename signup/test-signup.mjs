import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const config = await readFile(new URL("./config.js", import.meta.url), "utf8");
const optIn = await readFile(new URL("../OPT_IN_PROCESS.md", import.meta.url), "utf8");
const terms = await readFile(new URL("../TERMS_AND_CONDITIONS.md", import.meta.url), "utf8");

const CONSENT_TEXT = "I agree to receive automated SMS/MMS text messages from NRM related to logging and reviewing my personal relationship interactions. Message frequency varies. Message and data rates may apply. Reply STOP to any message to unsubscribe, or HELP for help.";
const SIGNUP_URL = "https://kristiananc.github.io/Network-Resource-Management-NRM-tool/signup/";

test("contains required fields and exact unchecked consent", () => {
  assert.match(html, /name="name"[^>]*type="text"[^>]*required/);
  assert.match(html, /name="phone_number"[\s\S]*?placeholder="\+1XXXXXXXXXX"[\s\S]*?required/);
  const checkbox = html.match(/<input id="consent"[^>]*>/)?.[0] || "";
  assert.match(checkbox, /type="checkbox"/);
  assert.match(checkbox, /required/);
  assert.doesNotMatch(checkbox, /\schecked(?:\s|>|=)/);
  assert.equal((html.match(new RegExp(CONSENT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
});

test("keeps submit disabled until consent and uses separate endpoint config", () => {
  assert.match(html, /id="submit-button"[^>]*disabled/);
  assert.match(html, /submitButton\.disabled = !consent\.checked \|\| submissionPending/);
  assert.match(html, /HTMLFormElement\.prototype\.submit\.call\(form\)/);
  assert.match(html, /event\.source !== responseFrame\.contentWindow/);
  assert.match(config, /REPLACE_WITH_ACCESS_REQUEST_WEB_APP_URL/);
});

test("shows policy links and removes legacy form URLs", () => {
  assert.match(html, /PRIVACY_POLICY\.md/);
  assert.match(html, /TERMS_AND_CONDITIONS\.md/);
  assert.match(optIn, new RegExp(SIGNUP_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(terms, new RegExp(SIGNUP_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(`${html}\n${optIn}\n${terms}`, /forms\.gle|docs\.google\.com\/forms/i);
});
