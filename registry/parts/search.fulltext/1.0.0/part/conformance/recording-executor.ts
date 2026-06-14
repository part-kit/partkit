/**
 * A SqlExecutor that records every statement and returns canned rows — used by
 * the DB-free invariants (1, 6): typed errors, fail-fast validation, and the
 * own-table-only assertion. Ranking/upsert/raw-query semantics run against real
 * Postgres in the gated block (docs/02 §4).
 */
import type { SqlExecutor } from "../src/index";

export class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  /** Rows returned for the next queries (e.g. a canned search-result row). */
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

/** A canned row shaped like SEARCH_SQL's output, so query() resolves DB-free. */
export function cannedResultRow(): Record<string, unknown> {
  return { ref: "r1", type: null, title: null, rank: 0.5, snippet: "…", metadata: {} };
}
