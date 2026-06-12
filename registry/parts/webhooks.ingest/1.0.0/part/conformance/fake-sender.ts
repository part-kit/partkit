/**
 * Protocol-faithful vendor signers (docs/02 §4). The inbound mirror of the
 * email part's FakeVendor: for webhooks the part IS the server side, so the
 * fake is the SENDER — each function implements a vendor's signing algorithm
 * independently, from the vendor's documentation, never by importing adapter
 * code. The suite and the adapter must agree at the wire format or fail.
 *
 * Stripe:            https://docs.stripe.com/webhooks#verify-manually
 * Standard Webhooks: https://www.standardwebhooks.com/ (the Svix wire format)
 */
import { createHash, createHmac } from "node:crypto";

export interface SignOptions {
  payload: string;
  secret: string;
  /** Unix seconds the delivery claims to be signed at. */
  timestamp: number;
  /** Prepend a non-matching signature of the same shape (key-rotation decoy). */
  decoy?: boolean;
}

/**
 * Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 over "<t>.<payload>">.
 * The whsec_… secret string is used as the HMAC key verbatim. Multiple
 * v1 elements may be present during key rotation; any one match verifies.
 */
export function signStripe(opts: SignOptions): Record<string, string> {
  const mac = createHmac("sha256", opts.secret)
    .update(`${opts.timestamp}.${opts.payload}`)
    .digest("hex");
  const elements = [`t=${opts.timestamp}`];
  if (opts.decoy === true) elements.push(`v1=${"0".repeat(64)}`);
  elements.push(`v1=${mac}`);
  return { "stripe-signature": elements.join(",") };
}

/**
 * webhook-id / webhook-timestamp / webhook-signature per Standard Webhooks:
 * base64 HMAC-SHA256 over "<id>.<timestamp>.<payload>", keyed by the
 * base64-decoded secret (whsec_ prefix stripped). The signature header is a
 * space-separated list of "v1,<base64>"; any one match verifies.
 */
export function signStandardWebhooks(opts: SignOptions): Record<string, string> {
  const id = `msg_${createHash("sha256").update(opts.payload).digest("hex").slice(0, 16)}`;
  const key = Buffer.from(opts.secret.replace(/^whsec_/, ""), "base64");
  const mac = createHmac("sha256", key)
    .update(`${id}.${opts.timestamp}.${opts.payload}`)
    .digest("base64");
  const sigs = opts.decoy === true ? [`v1,${"A".repeat(43)}=`, `v1,${mac}`] : [`v1,${mac}`];
  return {
    "webhook-id": id,
    "webhook-timestamp": String(opts.timestamp),
    "webhook-signature": sigs.join(" "),
  };
}
