import twilio from "twilio";

import { resolveOwnerId } from "./owner-map.ts";

export interface Env {
  TWILIO_AUTH_TOKEN: string;
  NRM_WORKER_HMAC_SECRET: string;
  APPS_SCRIPT_WEB_APP_URL: string;
}

export interface NormalizedInboundEvent {
  message_sid: string;
  owner_id: string;
  from: string;
  to: string;
  body: string;
  num_media: number;
  media: Array<{ url: string; content_type: string }>;
  received_at: string;
}

interface WorkerEnvelope {
  timestamp: string;
  payload: string;
  signature: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Clock = () => Date;

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  fetcher: Fetcher = fetch,
  clock: Clock = () => new Date(),
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const configurationError = validateConfiguration(env);
  if (configurationError) {
    logEdgeEvent("EDGE_CONFIG_ERROR", request, { code: configurationError });
    return new Response("Service Unavailable", { status: 503 });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    logEdgeEvent("INVALID_CONTENT_TYPE", request);
    return new Response("Unsupported Media Type", { status: 415 });
  }

  const rawBody = await request.text();
  const parameters = formParameters(rawBody);
  const twilioSignature = request.headers.get("x-twilio-signature") || "";
  const signatureIsValid = twilio.validateRequest(
    env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    request.url,
    parameters,
  );
  if (!signatureIsValid) {
    logEdgeEvent("BAD_TWILIO_SIGNATURE", request);
    return new Response("Forbidden", { status: 403 });
  }

  let sender: string;
  let ownerId: string | null;
  try {
    sender = singleParameter(parameters, "From");
    ownerId = resolveOwnerId(sender);
  } catch (error) {
    logEdgeEvent("INVALID_TWILIO_EVENT", request, {
      code: safeErrorCode(error),
    });
    return new Response("Bad Request", { status: 400 });
  }
  if (!ownerId) {
    logEdgeEvent("UNMAPPED_SENDER", request);
    return new Response("Forbidden", { status: 403 });
  }

  let event: NormalizedInboundEvent;
  try {
    event = normalizeTwilioEvent(parameters, ownerId, clock());
  } catch (error) {
    logEdgeEvent("INVALID_TWILIO_EVENT", request, {
      code: safeErrorCode(error),
    });
    return new Response("Bad Request", { status: 400 });
  }

  const forwarding = forwardToAppsScript(event, env, fetcher, clock).catch(() => {
    logEdgeEvent("APPS_SCRIPT_FORWARD_FAILED", request);
  });
  ctx.waitUntil(forwarding);

  return new Response(EMPTY_TWIML, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

export function normalizeTwilioEvent(
  parameters: Record<string, string | string[]>,
  ownerId: string,
  receivedAt: Date,
): NormalizedInboundEvent {
  const numMediaText = optionalSingleParameter(parameters, "NumMedia") || "0";
  if (!/^\d+$/.test(numMediaText)) {
    throw new Error("INVALID_NUM_MEDIA");
  }
  const numMedia = Number(numMediaText);
  if (!Number.isSafeInteger(numMedia) || numMedia > 100) {
    throw new Error("INVALID_NUM_MEDIA");
  }

  const media = Array.from({ length: numMedia }, (_, index) => ({
    url: requiredParameter(parameters, `MediaUrl${index}`),
    content_type: optionalSingleParameter(parameters, `MediaContentType${index}`),
  }));

  return {
    message_sid: requiredParameter(parameters, "MessageSid"),
    owner_id: ownerId,
    from: requiredParameter(parameters, "From"),
    to: requiredParameter(parameters, "To"),
    body: optionalSingleParameter(parameters, "Body"),
    num_media: numMedia,
    media,
    received_at: receivedAt.toISOString(),
  };
}

export async function createWorkerEnvelope(
  event: NormalizedInboundEvent,
  sharedSecret: string,
  now: Date,
): Promise<WorkerEnvelope> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const payload = encodeBase64Utf8(JSON.stringify(event));
  const signature = await hmacSha256Hex(`${timestamp}.${payload}`, sharedSecret);
  return { timestamp, payload, signature };
}

async function forwardToAppsScript(
  event: NormalizedInboundEvent,
  env: Env,
  fetcher: Fetcher,
  clock: Clock,
): Promise<void> {
  const envelope = await createWorkerEnvelope(event, env.NRM_WORKER_HMAC_SECRET, clock());
  const response = await fetcher(env.APPS_SCRIPT_WEB_APP_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify(envelope),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`APPS_SCRIPT_HTTP_${response.status}`);
  }
}

function formParameters(rawBody: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  new URLSearchParams(rawBody).forEach((value, key) => {
    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  });
  return result;
}

function requiredParameter(
  parameters: Record<string, string | string[]>,
  name: string,
): string {
  const value = singleParameter(parameters, name);
  if (!value) throw new Error(`MISSING_${name.toUpperCase()}`);
  return value;
}

function optionalSingleParameter(
  parameters: Record<string, string | string[]>,
  name: string,
): string {
  const value = parameters[name];
  if (value === undefined) return "";
  if (Array.isArray(value)) throw new Error(`DUPLICATE_${name.toUpperCase()}`);
  return value;
}

function singleParameter(
  parameters: Record<string, string | string[]>,
  name: string,
): string {
  return optionalSingleParameter(parameters, name);
}

function validateConfiguration(env: Env): string | null {
  if (!env.TWILIO_AUTH_TOKEN) return "MISSING_TWILIO_AUTH_TOKEN";
  if (!env.NRM_WORKER_HMAC_SECRET) return "MISSING_NRM_WORKER_HMAC_SECRET";
  if (!isHttpsUrl(env.APPS_SCRIPT_WEB_APP_URL)) return "INVALID_APPS_SCRIPT_WEB_APP_URL";
  return null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  return /^[A-Z0-9_]+$/.test(message) ? message : "INVALID_EVENT";
}

function logEdgeEvent(
  event: string,
  request: Request,
  extra: Record<string, string> = {},
): void {
  console.warn(JSON.stringify({
    level: "warn",
    event,
    method: request.method,
    path: new URL(request.url).pathname,
    ray_id: request.headers.get("cf-ray") || "",
    ...extra,
  }));
}
