import type { UsageError } from "./errors";
import type { ReportableEvent } from "./types";

/**
 * Every statement is a CONSTANT string with positional placeholders — no input
 * is concatenated into SQL, so metacharacters in subjectId/meter/metadata are
 * data, never code (contract invariant 7). Each references only the part-owned
 * `billing_usage_events` table.
 *
 * NOTE on NUMERIC: node-postgres returns NUMERIC (and bigint) as JS STRINGS, so
 * `quantity` is bound IN as a string ($n::numeric) and aggregates come OUT as
 * text (`::text`) for exact transport — mapped back via quantityToNumber.
 */

/** Idempotent record: a duplicate (subject_id, meter, idempotency_key) inserts nothing. */
export const INSERT_EVENT_SQL = `INSERT INTO billing_usage_events
  (id, subject_id, meter, quantity, occurred_at, idempotency_key, metadata)
VALUES ($1, $2, $3, $4::numeric, COALESCE($5::timestamptz, now()), $6, $7::jsonb)
ON CONFLICT (subject_id, meter, idempotency_key) DO NOTHING
RETURNING id`;

/** Resolve the original event id when an idempotent record hit a conflict. */
export const RESOLVE_BY_IDEM_SQL = `SELECT id FROM billing_usage_events
WHERE subject_id = $1 AND meter = $2 AND idempotency_key = $3`;

/** Aggregate one subject+meter over the half-open [since, until) window. */
export const TOTAL_SQL = `SELECT
  COALESCE(SUM(quantity), 0)::text AS quantity,
  COUNT(*)::bigint                 AS count
FROM billing_usage_events
WHERE subject_id = $1
  AND meter = $2
  AND ($3::timestamptz IS NULL OR occurred_at >= $3)
  AND ($4::timestamptz IS NULL OR occurred_at <  $4)`;

/** Per-meter breakdown for a subject over [since, until). */
export const SUMMARY_SQL = `SELECT
  meter,
  COALESCE(SUM(quantity), 0)::text AS quantity,
  COUNT(*)::bigint                 AS count
FROM billing_usage_events
WHERE subject_id = $1
  AND ($2::timestamptz IS NULL OR occurred_at >= $2)
  AND ($3::timestamptz IS NULL OR occurred_at <  $3)
GROUP BY meter
ORDER BY meter
LIMIT $4`;

/** The reporting drain: unreported rows, fewest-failures-then-oldest first, so a
 *  permanently-rejected event can never starve fresh usage. $1 = batch limit. */
export const SELECT_UNREPORTED_SQL = `SELECT
  id, subject_id, meter, quantity::text AS quantity, occurred_at, metadata
FROM billing_usage_events
WHERE reported_at IS NULL
ORDER BY report_attempts, seq
LIMIT $1`;

/** One-way mark: only an unreported row transitions, so a concurrent drain can't
 *  double-mark or overwrite (the webhooks.dispatch status-guard pattern). */
export const MARK_REPORTED_SQL = `UPDATE billing_usage_events
  SET reported_at = $2, reported_id = $3
WHERE id = $1 AND reported_at IS NULL`;

/** Count a failed report so the row sinks in the drain ordering (never blocks fresh). */
export const BUMP_ATTEMPT_SQL = `UPDATE billing_usage_events
  SET report_attempts = report_attempts + 1
WHERE id = $1 AND reported_at IS NULL`;

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/** NUMERIC/bigint arrive from node-postgres as strings; convert exactly. */
export function quantityToNumber(v: unknown, fail: (msg: string) => UsageError): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw fail("non-finite quantity from storage");
  return n;
}

/** Map a drain row → ReportableEvent. quantity stays the EXACT string (invariant 4/5). */
export function rowToReportable(row: Record<string, unknown>): ReportableEvent {
  const metadata = row["metadata"];
  return {
    eventId: String(row["id"]),
    subjectId: String(row["subject_id"]),
    meter: String(row["meter"]),
    quantity: String(row["quantity"]),
    occurredAt: asDate(row["occurred_at"]),
    metadata:
      metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {},
  };
}
