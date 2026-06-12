/**
 * A SqlExecutor that records every statement and returns canned rows — used by
 * the DB-free invariants (1, 2, 10): typed errors, fail-fast validation, and the
 * own-tables-only / no-cross-part-FK assertions. It is NOT used to test the
 * tenancy semantics — that would be mocking our own code (docs/02 §4); the
 * organization, membership, role, last-owner, cascade, and injection invariants
 * run against real Postgres in the gated block of the suite.
 */
import type { SqlExecutor } from "../src/index";

export class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  /** Rows returned for the next queries. */
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
