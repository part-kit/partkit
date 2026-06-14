import { randomBytes } from "node:crypto";

/**
 * A usage-event id. App-assigned (not a DB sequence) and URL-safe, because it is
 * ALSO the stable biller idempotency key (contract invariant 4) — it must be
 * known at insert time and be opaque/non-enumerable.
 */
export function newEventId(): string {
  return `ue_${randomBytes(18).toString("base64url")}`;
}
