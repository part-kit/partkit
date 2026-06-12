/** A fixed-window rule: at most `limit` requests per `windowSeconds`. */
export interface RateLimitRule {
  /** Max requests allowed within a window. Positive integer. */
  limit: number;
  /** Window length in seconds. Positive integer. */
  windowSeconds: number;
}

/** The outcome of one rate-limit check — public, re-exported by index.ts. */
export interface RateLimitResult {
  /** Was this request allowed? */
  ok: boolean;
  /** The rule's limit, echoed for header emission. */
  limit: number;
  /** Requests remaining in the current window. Never negative. */
  remaining: number;
  /** When the current window ends and the counter resets. */
  resetAt: Date;
  /** Seconds until reset — the Retry-After value on a rejection. */
  retryAfterSeconds: number;
  /** True when the result came from the fail-open/closed path on a store error. */
  degraded: boolean;
}

/**
 * The pluggable store SEAM (not a registry adapter): the app may hand in a
 * Redis-compatible backend for cross-instance limiting. Defaults to the
 * built-in per-instance in-memory store when omitted.
 *
 * Contract: atomically increment the counter at `bucketKey` and return the
 * NEW value; on first increment set the entry to expire after `ttlSeconds`
 * (Redis: `INCR` then `EXPIRE`). Atomicity per bucketKey is what makes the
 * count correct under concurrency — a non-atomic store undercounts.
 */
export interface RateLimitStore {
  increment(bucketKey: string, ttlSeconds: number): Promise<number> | number;
}

export interface RateLimitOpts {
  store?: RateLimitStore;
  /** On a store failure: true (default) allows the request, false rejects it. */
  failOpen?: boolean;
}

export interface RateLimitConfig {
  rule: RateLimitRule;
  /**
   * Derive the rate-limit key from the request. Defaults to the client IP
   * (first `x-forwarded-for` hop, then `x-real-ip`). Return null to fall back
   * to a single shared bucket — see seams.md on the trust boundary.
   */
  identify?: (request: Request) => string | null;
  store?: RateLimitStore;
  failOpen?: boolean;
}
