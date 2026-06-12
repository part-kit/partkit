export type RateLimitErrorCode = "invalid_rule" | "invalid_config";

/**
 * The only error type that escapes the part. Store failures do NOT throw —
 * they are absorbed into a degraded RateLimitResult per the configured policy
 * (contract invariant 7), so a Redis connection string in a driver error can
 * never surface through us. The only thrown errors are programming mistakes:
 * an invalid rule or invalid middleware config, caught at call time.
 */
export class RateLimitError extends Error {
  readonly code: RateLimitErrorCode;

  constructor(code: RateLimitErrorCode, message: string) {
    super(message);
    this.name = "RateLimitError";
    this.code = code;
  }
}
