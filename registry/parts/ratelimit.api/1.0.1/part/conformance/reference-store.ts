/**
 * An INDEPENDENT store implementation for the conformance suite — the analog
 * of email's protocol-faithful fake (docs/02 §4). ratelimit.api has no vendor
 * wire format and no registry adapters: its pluggable store is an app-provided
 * SEAM. To prove the limiter is genuinely store-agnostic, the same suite runs
 * against the part's built-in store AND this one, whose internals deliberately
 * differ — a plain-object map, fully async, eviction on write — so a test that
 * passes here cannot be quietly coupled to the default store's internals.
 *
 * It implements the contract a Redis-backed store must implement: atomically
 * increment the counter at `bucketKey`, returning the new value, and let the
 * entry expire after `ttlSeconds` (Redis: INCR then EXPIRE).
 */
import type { RateLimitStore } from "../src/index";

export class ReferenceStore implements RateLimitStore {
  private readonly buckets: Record<string, { count: number; expiresAtMs: number }> = {};

  async increment(bucketKey: string, ttlSeconds: number): Promise<number> {
    await Promise.resolve(); // genuinely async, unlike the built-in store
    const nowMs = Date.now();
    for (const [k, v] of Object.entries(this.buckets)) {
      if (v.expiresAtMs <= nowMs) delete this.buckets[k];
    }
    const existing = this.buckets[bucketKey];
    if (existing !== undefined && existing.expiresAtMs > nowMs) {
      existing.count += 1;
      return existing.count;
    }
    this.buckets[bucketKey] = { count: 1, expiresAtMs: nowMs + ttlSeconds * 1000 };
    return 1;
  }
}

/** A store that always fails — exercises the fail-open / fail-closed policy. */
export class FailingStore implements RateLimitStore {
  increment(): never {
    throw new Error("reference store outage: connection refused");
  }
}
