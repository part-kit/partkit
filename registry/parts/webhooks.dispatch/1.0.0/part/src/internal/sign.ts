/**
 * Standard Webhooks signing — the SEND side of the exact scheme webhooks.ingest's
 * `standardwebhooks` adapter verifies. Zero-dependency (node:crypto), so a
 * customer who can verify an inbound webhooks.ingest payload verifies ours with
 * the same code (RFC 0003 §1). This is a separate part, so it cannot import
 * webhooks.ingest's interior — the scheme is re-implemented here per RFC 0003 §4.
 *
 * Signed content = `${id}.${timestamp}.${body}` (single ASCII dots, no newline,
 * no trailing separator). HMAC-SHA256 keyed by the BASE64-DECODED secret body
 * (the `whsec_` prefix stripped). Signature header = `v1,<standard-base64>`.
 */
import { createHmac } from "node:crypto";

export interface SignedHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}

/** Decode a `whsec_<base64>` secret to the raw HMAC key bytes. */
function secretKey(secret: string): Buffer {
  return Buffer.from(secret.replace(/^whsec_/, ""), "base64");
}

/**
 * Produce the three Standard Webhooks headers for a delivery. `payload` is the
 * EXACT bytes that will be transmitted — sign what you send, byte-for-byte, or
 * the receiver's verification fails (contract invariant 3). `timestampSeconds`
 * must be the current unix-SECONDS time at SEND; retries re-sign with a fresh
 * timestamp so the receiver's tolerance window accepts them.
 */
export function signStandardWebhooks(opts: {
  id: string;
  payload: Buffer;
  secret: string;
  timestampSeconds: number;
}): SignedHeaders {
  const key = secretKey(opts.secret);
  const signedContent = Buffer.concat([
    Buffer.from(`${opts.id}.${opts.timestampSeconds}.`, "utf8"),
    opts.payload,
  ]);
  const mac = createHmac("sha256", key).update(signedContent).digest("base64");
  return {
    "webhook-id": opts.id,
    "webhook-timestamp": String(opts.timestampSeconds),
    "webhook-signature": `v1,${mac}`,
  };
}
