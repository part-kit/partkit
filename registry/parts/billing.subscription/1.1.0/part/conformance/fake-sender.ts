import { createHmac } from "node:crypto";

/**
 * Protocol-faithful Stripe webhook signer (no SDK) — the inverse of the part's
 * verifier, mirroring webhooks.ingest's fake-vendor approach. Produces a real
 * `Stripe-Signature` header so conformance can exercise verification offline,
 * with no network and no Stripe key. `decoy` prepends a non-matching v1 to
 * prove the verifier tolerates key-rotation (multiple v1 elements).
 */
export function signStripe(payload: string, secret: string, timestamp: number, decoy = false): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const elements = [`t=${timestamp}`];
  if (decoy) elements.push(`v1=${"0".repeat(64)}`);
  elements.push(`v1=${mac}`);
  return elements.join(",");
}

/**
 * Protocol-faithful Paddle webhook signer (no SDK). Produces a real
 * `Paddle-Signature` header: `ts=<unix>;h1=<hex>` where h1 = HMAC-SHA256 over
 * `${ts}:${rawBody}` keyed by the notification secret. The inverse of the
 * paddle adapter's verifier, so conformance exercises it offline.
 */
export function signPaddle(payload: string, secret: string, timestamp: number, decoy = false): string {
  const h1 = createHmac("sha256", secret).update(`${timestamp}:${payload}`).digest("hex");
  const elements = [`ts=${timestamp}`];
  if (decoy) elements.push(`h1=${"0".repeat(64)}`); // prove the verifier tolerates rotation (multiple h1)
  elements.push(`h1=${h1}`);
  return elements.join(";");
}
