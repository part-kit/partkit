import type { RateLimitStore } from "./types.js";

/**
 * The built-in store: a fixed-window counter held in process memory, PER
 * INSTANCE (contract invariant 4's serverless limitation, stated honestly in
 * SPEC.md). The window is encoded in the bucketKey by the caller, so a stale
 * bucket can never undercount a new window — expiry here is only about
 * reclaiming memory.
 *
 * Bounded: expired buckets are evicted on access and the map is capped, so a
 * flood of distinct keys degrades coverage, never memory safety (the same
 * discipline as the webhooks replay cache).
 */
const MAX_BUCKETS = 100_000;

export class MemoryStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; expiresAtMs: number }>();

  increment(bucketKey: string, ttlSeconds: number): number {
    const nowMs = Date.now();
    const existing = this.buckets.get(bucketKey);
    if (existing !== undefined && existing.expiresAtMs > nowMs) {
      existing.count += 1;
      return existing.count;
    }
    this.buckets.set(bucketKey, { count: 1, expiresAtMs: nowMs + ttlSeconds * 1000 });
    if (this.buckets.size > MAX_BUCKETS) this.evict(nowMs);
    return 1;
  }

  private evict(nowMs: number): void {
    for (const [k, v] of this.buckets) {
      if (v.expiresAtMs <= nowMs) this.buckets.delete(k);
    }
    // Still over cap after dropping expired: shed oldest-inserted (Map keeps
    // insertion order) until back under the limit.
    while (this.buckets.size > MAX_BUCKETS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
