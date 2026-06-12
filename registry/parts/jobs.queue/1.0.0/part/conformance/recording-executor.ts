/**
 * A SqlExecutor that records every statement and returns canned rows — used by
 * the DB-free invariants (1, 2, and the own-schema shape of 8): typed errors,
 * fail-fast validation, and the assertion that the enqueue/read seam touches
 * only the graphile_worker schema. It is NOT used to test queue semantics —
 * that would be mocking our own code (docs/02 §4); persistence, processing,
 * retry/backoff, dead-letter, cron, and the migration no-op run against real
 * graphile-worker + real Postgres in the gated block.
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
