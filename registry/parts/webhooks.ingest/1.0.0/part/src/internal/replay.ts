import { WebhookError } from "./errors.js";

/**
 * v1 replay defense: in-memory, PER INSTANCE (contract invariant 4; the
 * serverless limitation is stated honestly in SPEC.md — durable cross-instance
 * defense arrives with the DB story). Entries live as long as the tolerance
 * window: anything older is already rejected by the timestamp check, so the
 * cache and the window together cover the whole timeline on this instance.
 *
 * Note for vendor retries: both supported schemes re-sign redeliveries with a
 * fresh timestamp, so a legitimate retry never collides with a cached key.
 */
const MAX_ENTRIES = 10_000;

const seen = new Map<string, number>();

export function assertNotReplayed(
  key: string,
  nowEpochSeconds: number,
  ttlSeconds: number,
): void {
  const expiresAt = seen.get(key);
  if (expiresAt !== undefined && expiresAt > nowEpochSeconds) {
    throw new WebhookError(
      "replayed",
      "delivery replayed within the tolerance window (identical signature already accepted)",
    );
  }
  seen.set(key, nowEpochSeconds + ttlSeconds);

  if (seen.size > MAX_ENTRIES) {
    for (const [k, exp] of seen) {
      if (seen.size <= MAX_ENTRIES) break;
      if (exp <= nowEpochSeconds) seen.delete(k);
    }
    // Still over cap: drop oldest-inserted (Map preserves insertion order).
    while (seen.size > MAX_ENTRIES) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }
}
