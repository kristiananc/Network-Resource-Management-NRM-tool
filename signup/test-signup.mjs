import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const config = await readFile(new URL("./config.js", import.meta.url), "utf8");
const client = await readFile(new URL("./signup.js", import.meta.url), "utf8");
const optIn = await readFile(new URL("../OPT_IN_PROCESS.md", import.meta.url), "utf8");
const terms = await readFile(new URL("../TERMS_AND_CONDITIONS.md", import.meta.url), "utf8");

const SIGNUP_URL = "https://kristiananc.github.io/Network-Resource-Management-NRM-tool/signup/";
const ACCESS_REQUEST_ENDPOINT = "https://script.google.com/macros/s/AKfycbwLa22PkUFKYoiSrezaT9LDbB0s6tmENNF22Xk0zIFzshBtx9J0iGbAqrCvlBHrguKRMg/exec";

test("requires requester identity but leaves SMS consent optional and unchecked", () => {
  assert.match(html, /name="name"[^>]*type="text"[^>]*required/);
  assert.match(html, /name="phone_number"[\s\S]*?placeholder="\+1XXXXXXXXXX"[\s\S]*?required/);
  const checkbox = html.match(/<input id="consent"[^>]*>/)?.[0] || "";
  assert.match(checkbox, /type="checkbox"/);
  assert.doesNotMatch(checkbox, /\srequired(?:\s|>|=)/);
  assert.doesNotMatch(checkbox, /\schecked(?:\s|>|=)/);
  assert.match(html, /id="consent-value"[^>]*name="consent"[^>]*type="hidden"[^>]*value="false"/);
  assert.match(html, /optional box[\s\S]*automated SMS\/MMS[\s\S]*from NRM/);
  assert.match(html, /Message frequency varies/);
  assert.match(html, /Message and data[\s\S]*rates may apply/);
  assert.match(html, /Reply STOP[\s\S]*HELP for[\s\S]*help/);
});

test("allows submission without SMS consent and uses separate endpoint config", () => {
  const submitButton = html.match(/<button id="submit-button"[^>]*>/)?.[0] || "";
  assert.doesNotMatch(submitButton, /\sdisabled(?:\s|>|=)/);
  assert.match(html, /id="submission-id"[^>]*name="submission_id"[^>]*type="hidden"/);
  assert.match(html, /<script src="signup\.js"><\/script>/);
  assert.match(client, /submitButton\.disabled = submissionPending/);
  assert.match(client, /consentValueField\.value = consent\.checked \? "true" : "false"/);
  assert.match(client, /HTMLFormElement\.prototype\.submit\.call\(form\)/);
  assert.match(client, /RESPONSE_TIMEOUT_MS = 15000/);
  assert.match(config, new RegExp(ACCESS_REQUEST_ENDPOINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(config, /REPLACE_WITH_ACCESS_REQUEST_WEB_APP_URL/);
});

test("submits an unchecked checkbox with consent false", () => {
  const harness = createClientHarness();
  harness.submit({ consentChecked: false });

  assert.equal(harness.form.submitCount, 1);
  assert.deepEqual(harness.form.submittedPayload, { consent: "false" });
  assert.equal(harness.consent.checked, false);
  assert.equal(harness.consentValue.value, "false");
  assert.equal(harness.status.textContent, "Submitting your request…");
});

test("accepts a correlated response from an Apps Script sandbox origin", () => {
  const harness = createClientHarness();
  harness.submit();
  assert.equal(harness.form.action, ACCESS_REQUEST_ENDPOINT);
  assert.equal(harness.form.submitCount, 1);
  assert.equal(harness.status.textContent, "Submitting your request…");
  assert.equal(harness.submissionId.value, "submission-browser-test");

  harness.message({
    source: "nrm-access-request",
    ok: true,
    message: "Access request received.",
    request_id: "request-1",
    submission_id: "submission-browser-test"
  }, "https://n-5rjxmymum3iuibwzr7n5v7lmnvehw7a2qgt4vei-0lu-script.googleusercontent.com");

  assert.equal(harness.status.textContent, "Access request received.");
  assert.equal(harness.status.className, "success");
  assert.equal(harness.form.resetCount, 1);
  assert.equal(harness.submitButton.disabled, false);
  assert.equal(harness.pendingTimers(), 0);
});

test("silently ignores responses from unrelated origins", () => {
  const harness = createClientHarness();
  harness.submit();
  harness.message({
    source: "nrm-access-request",
    ok: true,
    message: "Forged success.",
    request_id: "request-forged",
    submission_id: "submission-browser-test"
  }, "https://not-googleusercontent.com");

  assert.equal(harness.status.textContent, "Submitting your request…");
  assert.equal(harness.form.resetCount, 0);
  assert.equal(harness.pendingTimers(), 1);
});

test("shows an Apps Script failure response without resetting the form", () => {
  const harness = createClientHarness();
  harness.submit();
  harness.message({
    source: "nrm-access-request",
    ok: false,
    message: "The request could not be submitted. Please contact support.",
    request_id: "",
    submission_id: "submission-browser-test"
  });

  assert.equal(harness.status.textContent, "The request could not be submitted. Please contact support.");
  assert.equal(harness.status.className, "error");
  assert.equal(harness.form.resetCount, 0);
  assert.equal(harness.submitButton.disabled, false);
  assert.equal(harness.pendingTimers(), 0);
});

test("times out visibly after 15 seconds when no response arrives", () => {
  const harness = createClientHarness();
  harness.submit();
  assert.equal(harness.lastTimerDelay(), 15000);
  harness.runPendingTimer();

  assert.equal(harness.status.textContent, "We could not confirm your request. Please check back or try again.");
  assert.equal(harness.status.className, "error");
  assert.equal(harness.form.resetCount, 0);
  assert.equal(harness.submitButton.disabled, false);
  assert.equal(harness.pendingTimers(), 0);
});

test("shows policy links and removes legacy form URLs", () => {
  assert.match(html, /PRIVACY_POLICY\.md/);
  assert.match(html, /TERMS_AND_CONDITIONS\.md/);
  assert.match(optIn, new RegExp(SIGNUP_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(terms, new RegExp(SIGNUP_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(`${html}\n${optIn}\n${terms}`, /forms\.gle|docs\.google\.com\/forms/i);
});

function createClientHarness() {
  class FakeElement {
    constructor() {
      this.listeners = new Map();
      this.checked = false;
      this.disabled = false;
      this.value = "";
      this.textContent = "";
      this.className = "";
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    dispatch(type, event = {}) {
      this.listeners.get(type)?.(event);
    }
  }

  class FakeHTMLFormElement extends FakeElement {
    constructor(consent, consentValue) {
      super();
      this.consent = consent;
      this.consentValue = consentValue;
      this.action = "";
      this.submitCount = 0;
      this.resetCount = 0;
      this.submittedPayload = null;
    }

    reportValidity() {
      return true;
    }

    reset() {
      this.resetCount += 1;
      this.consent.checked = false;
      this.consentValue.value = "false";
    }

    submit() {
      this.submitCount += 1;
      this.submittedPayload = {
        consent: this.consentValue.value
      };
    }
  }

  const consent = new FakeElement();
  const consentValue = new FakeElement();
  consentValue.value = "false";
  const submissionId = new FakeElement();
  const submitButton = new FakeElement();
  const status = new FakeElement();
  const form = new FakeHTMLFormElement(consent, consentValue);
  const elements = new Map([
    ["access-request-form", form],
    ["consent", consent],
    ["consent-value", consentValue],
    ["submission-id", submissionId],
    ["submit-button", submitButton],
    ["submission-status", status]
  ]);
  const windowListeners = new Map();
  const timers = new Map();
  let timerSequence = 0;
  let latestTimerDelay = null;
  const fakeWindow = {
    NRM_ACCESS_REQUEST_ENDPOINT: ACCESS_REQUEST_ENDPOINT,
    crypto: { randomUUID: () => "submission-browser-test" },
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    setTimeout: (callback, delay) => {
      latestTimerDelay = delay;
      const id = ++timerSequence;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  };
  const context = {
    window: fakeWindow,
    document: { getElementById: (id) => elements.get(id) || null },
    HTMLFormElement: FakeHTMLFormElement,
    URL,
    Date,
    Math
  };
  vm.runInNewContext(client, context, { filename: "signup/signup.js" });

  return {
    form,
    consent,
    consentValue,
    submissionId,
    submitButton,
    status,
    submit({ consentChecked = true } = {}) {
      consent.checked = consentChecked;
      consent.dispatch("change");
      form.dispatch("submit", { preventDefault() {} });
    },
    message(data, origin = "https://script.googleusercontent.com") {
      windowListeners.get("message")?.({
        origin,
        data
      });
    },
    pendingTimers: () => timers.size,
    lastTimerDelay: () => latestTimerDelay,
    runPendingTimer() {
      const entry = timers.entries().next().value;
      assert.ok(entry, "Expected a pending response timer.");
      entry[1]();
    }
  };
}
