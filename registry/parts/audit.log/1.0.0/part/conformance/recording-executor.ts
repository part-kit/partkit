/**
 * A SqlExecutor that records every statement and returns canned rows — used by
 * the DB-free invariants (1, 6, 7): typed errors, fail-fast validation, and the
 * own-table-only assertion. It is NOT used to test persistence — that would be
 * mocking our own code (docs/02 §4); the persistence invariants run against
 * real Postgres in the gated block of the suite.
 */
import type { SqlExecutor } from "../src/index.js";

export class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  /** Rows returned for the next queries (e.g. a canned RETURNING row). */
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

/** A canned row shaped like the INSERT ... RETURNING clause, so append resolves. */
export function cannedRow(): Record<string, unknown> {
  return {
    id: "1",
    occurred_at: new Date("2026-06-11T00:00:00.000Z"),
    actor: "user_1",
    action: "user.login",
    target: null,
    metadata: {},
  };
}
