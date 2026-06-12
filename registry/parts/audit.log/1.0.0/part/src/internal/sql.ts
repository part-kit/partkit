import type { AuditEvent } from "./types.js";

/**
 * Every statement is a CONSTANT string with positional placeholders — no input
 * is ever concatenated into SQL, so metacharacters in actor/action/target/
 * metadata are data, never code (contract invariant 5). Both reference only
 * the part-owned `audit_events` table (invariant 7).
 */
export const INSERT_SQL = `INSERT INTO audit_events (actor, action, target, metadata)
VALUES ($1, $2, $3, $4::jsonb)
RETURNING id, occurred_at, actor, action, target, metadata`;

/**
 * Filters are applied with NULL-guards so one constant statement serves every
 * filter combination — `($1::text IS NULL OR actor = $1)` is a no-op when the
 * filter is absent. Newest-first by the monotonic id; the `before` cursor and
 * the bounded limit make pagination deterministic.
 */
export const SELECT_SQL = `SELECT id, occurred_at, actor, action, target, metadata
FROM audit_events
WHERE ($1::text IS NULL OR actor = $1)
  AND ($2::text IS NULL OR action = $2)
  AND ($3::text IS NULL OR target = $3)
  AND ($4::timestamptz IS NULL OR occurred_at >= $4)
  AND ($5::timestamptz IS NULL OR occurred_at < $5)
  AND ($6::bigint IS NULL OR id < $6)
ORDER BY id DESC
LIMIT $7`;

/** Map a raw DB row (bigint→string, jsonb→object) to the public AuditEvent. */
export function rowToEvent(row: Record<string, unknown>): AuditEvent {
  const occurred = row["occurred_at"];
  const metadata = row["metadata"];
  return {
    id: String(row["id"]),
    occurredAt: occurred instanceof Date ? occurred : new Date(String(occurred)),
    actor: row["actor"] === null || row["actor"] === undefined ? null : String(row["actor"]),
    action: String(row["action"]),
    target: row["target"] === null || row["target"] === undefined ? null : String(row["target"]),
    metadata:
      metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {},
  };
}
