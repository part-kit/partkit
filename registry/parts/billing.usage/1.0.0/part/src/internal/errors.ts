/**
 * The only error type that escapes the part. `invalid_input` = bad arguments;
 * `config` = a required env var (the biller secret) is missing at first use;
 * `vendor` = the biller (Stripe) rejected a report; `storage` = the SqlExecutor
 * failed. Every message is run through `redactSecrets` at the throw site, so the
 * biller secret never appears (contract invariant 6).
 */
export type UsageErrorCode = "invalid_input" | "config" | "vendor" | "storage";

export class UsageError extends Error {
  readonly code: UsageErrorCode;

  constructor(code: UsageErrorCode, message: string) {
    super(message);
    this.name = "UsageError";
    this.code = code;
    Object.setPrototypeOf(this, UsageError.prototype);
  }
}
