/**
 * Stage 5 authorization boundary.
 *
 * Authorized E.164 senders map to stable opaque owner IDs. This file contains
 * no credentials; the Twilio auth token and Worker-to-Apps-Script HMAC key
 * remain Cloudflare Worker secrets.
 */
export const AUTHORIZED_SENDERS: Readonly<Record<string, string>> = Object.freeze({
  "+19097719380": "own_live_a",
});

export function resolveOwnerId(fromNumber: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(AUTHORIZED_SENDERS, fromNumber)) {
    return null;
  }
  const ownerId = AUTHORIZED_SENDERS[fromNumber];
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new Error("INVALID_OWNER_MAP");
  }
  return ownerId;
}
