/**
 * A SqlExecutor that records every statement and returns canned rows — used by
 * the DB-free invariants (1, 2-shape, 3, 4, 5): typed errors, the column
 * projection, unknown-resource rejection, the write boundary (zero SQL on
 * writes), and identifier/parameterization safety. It is NOT used to test real
 * projection against data — that runs against real Postgres in the gated block.
 */
import type { SqlExecutor } from "../src/index";

export class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  rows: Record<string, unknown>[] = [];
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
