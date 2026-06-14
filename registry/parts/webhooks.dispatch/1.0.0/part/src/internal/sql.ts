import type { DeliveryAttempt, DeliveryOutcome } from "./types";

/**
 * Every statement is a CONSTANT string with positional placeholders — no input
 * is concatenated into SQL, so metacharacters in ownerId/url/payload are data,
 * never code (contract invariant 8). Each references only the part-owned
 * webhooks_dispatch_* tables.
 */

export const INSERT_ENDPOINT_SQL = `INSERT INTO webhooks_dispatch_endpoints
  (id, owner_id, url, secret, event_types)
VALUES ($1, $2, $3, $4, $5::text[])
RETURNING id`;

export const SELECT_ENDPOINT_SQL = `SELECT id, owner_id, url, secret, event_types
FROM webhooks_dispatch_endpoints WHERE id = $1`;

/** Idempotent enqueue: a duplicate (endpoint_id, idempotency_key) inserts nothing. */
export const INSERT_OUTBOX_SQL = `INSERT INTO webhooks_dispatch_outbox
  (id, endpoint_id, event_type, payload, idempotency_key, status, attempt_count, next_attempt_at)
VALUES ($1, $2, $3, $4, $5, 'pending', 0, now())
ON CONFLICT (endpoint_id, idempotency_key) DO NOTHING
RETURNING id`;

/** Resolve the existing message id when an idempotent enqueue hit a conflict. */
export const SELECT_OUTBOX_BY_IDEM_SQL = `SELECT id FROM webhooks_dispatch_outbox
WHERE endpoint_id = $1 AND idempotency_key = $2`;

/** The due-work query: pending rows whose backoff has elapsed, joined to their
 *  endpoint for the url + signing secret. $1 = now, $2 = batch. */
export const SELECT_DUE_SQL = `SELECT
  o.id, o.endpoint_id, o.event_type, o.payload, o.attempt_count,
  e.url AS endpoint_url, e.secret AS endpoint_secret
FROM webhooks_dispatch_outbox o
JOIN webhooks_dispatch_endpoints e ON e.id = o.endpoint_id
WHERE o.status = 'pending' AND o.next_attempt_at <= $1
ORDER BY o.next_attempt_at
LIMIT $2`;

// The `AND status = 'pending'` guard makes every transition one-way: a row that
// another (concurrent) drain already finalized can't be flipped back to pending
// or re-finalized — so a delivered/dead row is never resurrected and the
// dead-letter guarantee holds even if two drains overlap (contract invariant 4).
export const MARK_DELIVERED_SQL = `UPDATE webhooks_dispatch_outbox
  SET status = 'delivered', attempt_count = $2, delivered_at = $3
WHERE id = $1 AND status = 'pending'`;

export const MARK_RETRY_SQL = `UPDATE webhooks_dispatch_outbox
  SET status = 'pending', attempt_count = $2, next_attempt_at = $3
WHERE id = $1 AND status = 'pending'`;

export const MARK_DEAD_SQL = `UPDATE webhooks_dispatch_outbox
  SET status = 'dead', attempt_count = $2
WHERE id = $1 AND status = 'pending'`;

export const INSERT_ATTEMPT_SQL = `INSERT INTO webhooks_dispatch_attempts
  (message_id, attempt_no, attempted_at, status_code, outcome, latency_ms, next_attempt_at, error)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

export const SELECT_ATTEMPTS_SQL = `SELECT
  message_id, attempt_no, attempted_at, status_code, outcome, latency_ms, next_attempt_at, error
FROM webhooks_dispatch_attempts WHERE message_id = $1 ORDER BY attempt_no`;

export interface EndpointRow {
  id: string;
  ownerId: string;
  url: string;
  secret: string;
  eventTypes: string[] | null;
}

export interface DueRow {
  id: string;
  endpointId: string;
  eventType: string;
  payload: string;
  attemptCount: number;
  url: string;
  secret: string;
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(String(v));
}

function asIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function rowToEndpoint(row: Record<string, unknown>): EndpointRow {
  return {
    id: String(row["id"]),
    ownerId: String(row["owner_id"]),
    url: String(row["url"]),
    secret: String(row["secret"]),
    eventTypes: Array.isArray(row["event_types"]) ? row["event_types"].map((t) => String(t)) : null,
  };
}

export function rowToDue(row: Record<string, unknown>): DueRow {
  return {
    id: String(row["id"]),
    endpointId: String(row["endpoint_id"]),
    eventType: String(row["event_type"]),
    payload: String(row["payload"]),
    attemptCount: Number(row["attempt_count"]),
    url: String(row["endpoint_url"]),
    secret: String(row["endpoint_secret"]),
  };
}

export function rowToAttempt(row: Record<string, unknown>): DeliveryAttempt {
  return {
    messageId: String(row["message_id"]),
    attemptNo: Number(row["attempt_no"]),
    attemptedAt: asDate(row["attempted_at"]) ?? new Date(0),
    statusCode: asIntOrNull(row["status_code"]),
    outcome: String(row["outcome"]) as DeliveryOutcome,
    latencyMs: asIntOrNull(row["latency_ms"]),
    nextAttemptAt: asDate(row["next_attempt_at"]),
    error: row["error"] === null || row["error"] === undefined ? null : String(row["error"]),
  };
}
