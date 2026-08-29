/**
 * Stage 5 authorization boundary.
 *
 * Replace these placeholder E.164 numbers and opaque owner IDs before live
 * deployment. This file contains no credentials; the Twilio auth token and
 * Worker-to-Apps-Script HMAC key remain Cloudflare Worker secrets.
 */
export const AUTHORIZED_SENDERS: Readonly<Record<string, string>> = Object.freeze({
  "+12025550101": "own_beta_001",
  "+12025550102": "own_beta_002",
  "+12025550103": "own_beta_003",
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
