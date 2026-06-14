/**
 * The single typed error surface. A raw Stripe/SDK/driver error can carry the
 * secret key or connection string; callers ALWAYS wrap with redactSecrets()
 * from config before constructing a BillingError, so secrets never escape.
 */
export type BillingErrorCode =
  | "config" // missing/blank required env
  | "invalid_input" // blank/unknown planId, empty userId
  | "not_found" // unknown subscription / user
  | "invalid_signature" // webhook HMAC mismatch / missing header
  | "timestamp_out_of_window" // signed timestamp outside the tolerance
  | "vendor" // a payment-vendor API error (message redacted)
  | "storage"; // the SqlExecutor threw

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  constructor(code: BillingErrorCode, message: string) {
    super(message);
    this.name = "BillingError";
    this.code = code;
    // Preserve instanceof across the transpile target.
    Object.setPrototypeOf(this, BillingError.prototype);
  }
}
