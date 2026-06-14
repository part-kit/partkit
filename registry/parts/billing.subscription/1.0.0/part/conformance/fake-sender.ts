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
