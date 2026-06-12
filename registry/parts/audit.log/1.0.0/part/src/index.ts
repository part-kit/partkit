/**
 * audit.log — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 */
import { AuditError } from "./internal/errors.js";
import { INSERT_SQL, rowToEvent, SELECT_SQL } from "./internal/sql.js";
import type {
  AuditEvent,
  AuditEventInput,
  AuditLog,
  AuditQuery,
  SqlExecutor,
} from "./internal/types.js";
import { validateEvent, validateQuery } from "./internal/validate.js";

export { AuditError } from "./internal/errors.js";
export type { AuditErrorCode } from "./internal/errors.js";
export type {
  AuditEvent,
  AuditEventInput,
  AuditLog,
  AuditQuery,
  SqlExecutor,
} from "./internal/types.js";

/**
 * Bind an append-only audit log to a database connection (the SqlExecutor
 * seam). Constructing it performs no I/O and never throws — configuration is
 * validated, and the database touched, only when `append`/`query` run
 * (contract invariant 1, serverless-safe). Pass a per-request executor from
 * your pool; the part runs on the connection/transaction you hand it.
 */
export function auditLog(db: SqlExecutor): AuditLog {
  return {
    append: (event: AuditEventInput): Promise<AuditEvent> => appendEvent(db, event),
    query: (filter?: AuditQuery): Promise<AuditEvent[]> => queryEvents(db, filter ?? {}),
  };
}

async function appendEvent(db: SqlExecutor, event: AuditEventInput): Promise<AuditEvent> {
  const v = validateEvent(event); // throws AuditError("invalid_event") before any SQL
  let result: { rows: Record<string, unknown>[] };
  try {
    result = await db.query(INSERT_SQL, [v.actor, v.action, v.target, v.metadataJson]);
  } catch (e) {
    throw new AuditError("storage", "failed to append audit event", { cause: e });
  }
  const row = result.rows[0];
  if (row === undefined) {
    throw new AuditError("storage", "append returned no row — is the audit_events migration applied?");
  }
  return rowToEvent(row);
}

async function queryEvents(db: SqlExecutor, filter: AuditQuery): Promise<AuditEvent[]> {
  const v = validateQuery(filter); // throws AuditError("invalid_query") before any SQL
  let result: { rows: Record<string, unknown>[] };
  try {
    result = await db.query(SELECT_SQL, [
      v.actor,
      v.action,
      v.target,
      v.since,
      v.until,
      v.before,
      v.limit,
    ]);
  } catch (e) {
    throw new AuditError("storage", "failed to query audit events", { cause: e });
  }
  return result.rows.map(rowToEvent);
}
