/**
 * The driver-free database seam — the same minimal `node-postgres` Client/Pool
 * shape `partkit migrate` uses. The app wires its own `pg` Pool to this; the
 * part imports no driver (contract invariant 7). Wiring example: seams.md §2.
 */
export interface SqlExecutor {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** What the app appends. `occurred_at` and `id` are server-assigned, not here. */
export interface AuditEventInput {
  /** Required verb, e.g. "user.login", "billing.charge". */
  action: string;
  /** Who acted — a user id, service name, etc. Null/omitted = system/anonymous. */
  actor?: string | null;
  /** The object acted upon, e.g. "post:123". Optional. */
  target?: string | null;
  /** Arbitrary structured detail, stored as jsonb. */
  metadata?: Record<string, unknown>;
}

/** A stored event — public, re-exported by index.ts. */
export interface AuditEvent {
  /** Monotonic id (bigint serialized as string for JS-safe comparison). */
  id: string;
  /** Server-assigned timestamp — the trustworthy timeline. */
  occurredAt: Date;
  actor: string | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown>;
}

/** Filters for `query` — all optional; every field is an exact match but time. */
export interface AuditQuery {
  actor?: string;
  action?: string;
  target?: string;
  /** Inclusive lower bound on occurred_at. */
  since?: Date;
  /** Exclusive upper bound on occurred_at. */
  until?: Date;
  /** Cursor: return events strictly older than this id (for pagination). */
  before?: string;
  /** Max rows, 1..1000, default 100. */
  limit?: number;
}

export interface AuditLog {
  append(event: AuditEventInput): Promise<AuditEvent>;
  query(filter?: AuditQuery): Promise<AuditEvent[]>;
}
