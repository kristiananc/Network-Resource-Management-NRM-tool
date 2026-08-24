/**
 * NRM Stage 0 authorized-sender configuration format.
 *
 * Configuration only — no sender-resolution application logic is implemented
 * in Stage 0.
 *
 * Replace the placeholder E.164 phone numbers and owner IDs before beta use.
 * owner_id must be stable and opaque; do not encode private user data in it.
 *
 * SECURITY NOTE:
 * This file contains no secrets. If you decide that beta-tester phone numbers
 * should not live in source control, move the same mapping shape into a
 * Worker-managed configuration/secret mechanism during deployment.
 */

export const AUTHORIZED_SENDERS: Readonly<Record<string, string>> = {
  "+12025550101": "own_beta_001",
  "+12025550102": "own_beta_002",
  "+12025550103": "own_beta_003",
};
