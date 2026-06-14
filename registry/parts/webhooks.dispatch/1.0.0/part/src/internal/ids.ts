import { randomBytes } from "node:crypto";

/** Endpoint handle, URL-safe. */
export function newEndpointId(): string {
  return `ep_${randomBytes(12).toString("base64url")}`;
}

/**
 * Outbox id / Standard Webhooks `webhook-id`. URL-safe and unique per message so
 * a receiver's replay cache (keyed on id+signature) never rejects a distinct
 * event (contract invariant 5).
 */
export function newMessageId(): string {
  return `msg_${randomBytes(18).toString("base64url")}`;
}

/**
 * A Standard Webhooks signing secret, `whsec_<base64>`. 192 bits. The base64
 * body is what the signer base64-DECODES to the raw HMAC key, so a receiver
 * using the same `whsec_…` string verifies our deliveries.
 */
export function newSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}
