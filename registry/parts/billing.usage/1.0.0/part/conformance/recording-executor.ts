/**
 * A SqlExecutor that records every statement and returns canned rows — used by
 * the DB-free invariants (1, 2-validation, 6, 7): typed errors, fail-fast
 * validation, secret redaction, and the own-table-only assertion. Persistence /
 * aggregation / drain run against real Postgres in the gated blocks (docs/02 §4).
 */
import type { SqlExecutor } from "../src/index";

export class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  /** Rows returned for the next queries (e.g. a canned INSERT … RETURNING id). */
  rows: Record<string, unknown>[] = [];
  /** When set, every query rejects with this — simulates a driver outage. */
  failWith: Error | null = null;

  async query(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, params });
    if (this.failWith !== null) throw this.failWith;
    return { rows: this.rows };
  }
}

/** A canned row shaped like record()'s INSERT … RETURNING id, so it resolves. */
export function cannedEventRow(): Record<string, unknown> {
  return { id: "ue_canned" };
}
