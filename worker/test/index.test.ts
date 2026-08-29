import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import twilio from "twilio";

import {
  type Env,
  handleRequest,
} from "../src/index.ts";

const WEBHOOK_URL = "https://nrm-worker.example.test/twilio";
const APPS_SCRIPT_URL = "https://script.google.test/macros/s/deployment/exec";
const TWILIO_AUTH_TOKEN = "stage5-test-twilio-token";
const WORKER_HMAC_SECRET = "stage5-test-worker-hmac-secret";
const FIXED_DATE = new Date("2026-08-28T19:20:21.000Z");

const ENV: Env = {
  TWILIO_AUTH_TOKEN,
  NRM_WORKER_HMAC_SECRET: WORKER_HMAC_SECRET,
  APPS_SCRIPT_WEB_APP_URL: APPS_SCRIPT_URL,
};

function signedRequest(
  parameters: Record<string, string>,
  options: { signature?: string; url?: string; contentType?: string } = {},
): Request {
  const body = new URLSearchParams(parameters).toString();
  const signature = options.signature === undefined
    ? twilio.getExpectedTwilioSignature(TWILIO_AUTH_TOKEN, WEBHOOK_URL, parameters)
    : options.signature;
  return new Request(options.url || WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": options.contentType || "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
      "cf-ray": "stage5-test-ray",
    },
    body,
  });
}

function baseParameters(from = "+12025550101"): Record<string, string> {
  return {
    Body: "Met Sarah for coffee.",
    From: from,
    To: "+12025550999",
    MessageSid: "SM_STAGE5_001",
    NumMedia: "0",
  };
}

function mockContext(): {
  ctx: Pick<ExecutionContext, "waitUntil">;
  pending: Promise<unknown>[];
} {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    },
  };
}

test("rejects an invalid Twilio signature before forwarding or owner workflow", async () => {
  const { ctx, pending } = mockContext();
  let fetchCalls = 0;
  const request = signedRequest(baseParameters(), { signature: "invalid-signature" });
  const logs: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    const response = await handleRequest(request, ENV, ctx, async () => {
      fetchCalls += 1;
      return new Response("ok");
    }, () => FIXED_DATE);
    assert.equal(response.status, 403);
    assert.equal(fetchCalls, 0);
    assert.equal(pending.length, 0);
    assert.match(logs.join("\n"), /"event":"BAD_TWILIO_SIGNATURE"/);
    assert.doesNotMatch(logs.join("\n"), /stage5-test-twilio-token/);
    assert.doesNotMatch(logs.join("\n"), /invalid-signature/);
    assert.doesNotMatch(logs.join("\n"), /\+12025550101/);
  } finally {
    console.warn = originalWarn;
  }
});

test("rejects a verified but unmapped sender before forwarding", async () => {
  const { ctx, pending } = mockContext();
  let fetchCalls = 0;
  const logs: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    const response = await handleRequest(
      signedRequest(baseParameters("+12025550998")),
      ENV,
      ctx,
      async () => {
        fetchCalls += 1;
        return new Response("ok");
      },
      () => FIXED_DATE,
    );
    assert.equal(response.status, 403);
    assert.equal(fetchCalls, 0);
    assert.equal(pending.length, 0);
    assert.match(logs.join("\n"), /"event":"UNMAPPED_SENDER"/);
    assert.doesNotMatch(logs.join("\n"), /\+12025550998/);
    assert.doesNotMatch(logs.join("\n"), /stage5-test-twilio-token/);
  } finally {
    console.warn = originalWarn;
  }
});

test("normalizes MMS, authenticates the Apps Script envelope, and preserves owner_id", async () => {
  const parameters = {
    ...baseParameters("+12025550102"),
    MessageSid: "SM_STAGE5_MEDIA",
    NumMedia: "2",
    MediaUrl0: "https://api.twilio.test/media/0",
    MediaContentType0: "image/jpeg",
    MediaUrl1: "https://api.twilio.test/media/1",
    MediaContentType1: "image/png",
  };
  const { ctx, pending } = mockContext();
  let forwardedUrl = "";
  let forwardedBody = "";
  const response = await handleRequest(
    signedRequest(parameters),
    ENV,
    ctx,
    async (input, init) => {
      forwardedUrl = String(input);
      forwardedBody = String(init?.body || "");
      return new Response("ok", { status: 200 });
    },
    () => FIXED_DATE,
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /<Response><\/Response>/);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(forwardedUrl, APPS_SCRIPT_URL);

  const envelope = JSON.parse(forwardedBody) as {
    timestamp: string;
    payload: string;
    signature: string;
  };
  assert.equal(envelope.timestamp, "1787944821");
  const expectedSignature = createHmac("sha256", WORKER_HMAC_SECRET)
    .update(`${envelope.timestamp}.${envelope.payload}`)
    .digest("hex");
  assert.equal(envelope.signature, expectedSignature);
  assert.deepEqual(JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")), {
    message_sid: "SM_STAGE5_MEDIA",
    owner_id: "own_beta_002",
    from: "+12025550102",
    to: "+12025550999",
    body: "Met Sarah for coffee.",
    num_media: 2,
    media: [
      { url: "https://api.twilio.test/media/0", content_type: "image/jpeg" },
      { url: "https://api.twilio.test/media/1", content_type: "image/png" },
    ],
    received_at: "2026-08-28T19:20:21.000Z",
  });
});

test("returns Twilio acknowledgement without waiting for Apps Script", async () => {
  const { ctx, pending } = mockContext();
  let resolveFetch: ((response: Response) => void) | undefined;
  const neverReadyUntilResolved = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });

  const response = await handleRequest(
    signedRequest(baseParameters()),
    ENV,
    ctx,
    async () => neverReadyUntilResolved,
    () => FIXED_DATE,
  );
  assert.equal(response.status, 200);
  assert.equal(pending.length, 1);
  assert.match(await response.text(), /<Response><\/Response>/);

  resolveFetch?.(new Response("ok", { status: 200 }));
  await Promise.all(pending);
});

test("uses the exact received webhook URL for signature validation", async () => {
  const { ctx, pending } = mockContext();
  let fetchCalls = 0;
  const response = await handleRequest(
    signedRequest(baseParameters(), { url: `${WEBHOOK_URL}/wrong-path` }),
    ENV,
    ctx,
    async () => {
      fetchCalls += 1;
      return new Response("ok");
    },
    () => FIXED_DATE,
  );
  assert.equal(response.status, 403);
  assert.equal(fetchCalls, 0);
  assert.equal(pending.length, 0);
});

test("rejects missing secrets and malformed media without forwarding", async () => {
  const missingSecret = { ...ENV, TWILIO_AUTH_TOKEN: "" };
  const missingContext = mockContext();
  const missingResponse = await handleRequest(
    signedRequest(baseParameters()),
    missingSecret,
    missingContext.ctx,
    async () => new Response("should not run"),
    () => FIXED_DATE,
  );
  assert.equal(missingResponse.status, 503);
  assert.equal(missingContext.pending.length, 0);

  const malformed = { ...baseParameters(), NumMedia: "1" };
  const malformedContext = mockContext();
  let fetchCalls = 0;
  const malformedResponse = await handleRequest(
    signedRequest(malformed),
    ENV,
    malformedContext.ctx,
    async () => {
      fetchCalls += 1;
      return new Response("should not run");
    },
    () => FIXED_DATE,
  );
  assert.equal(malformedResponse.status, 400);
  assert.equal(fetchCalls, 0);
  assert.equal(malformedContext.pending.length, 0);

  const missingFrom = baseParameters();
  delete missingFrom.From;
  const missingFromContext = mockContext();
  const missingFromResponse = await handleRequest(
    signedRequest(missingFrom),
    ENV,
    missingFromContext.ctx,
    async () => {
      fetchCalls += 1;
      return new Response("should not run");
    },
    () => FIXED_DATE,
  );
  assert.equal(missingFromResponse.status, 403);
  assert.equal(fetchCalls, 0);
  assert.equal(missingFromContext.pending.length, 0);
});
