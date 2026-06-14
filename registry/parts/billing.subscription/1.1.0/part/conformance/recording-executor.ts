import type { SqlExecutor } from "../src/internal/types";

/**
 * A SqlExecutor that records every statement (for the DB-free blocks: assert
 * zero writes on invalid input, and that emitted SQL targets only billing_
 * tables and is parameterized). `rows` is the canned result; `failWith` forces
 * a storage error.
 */
export class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  rows: Record<string, unknown>[] = [];
  failWith: Error | null = null;

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, params });
    if (this.failWith !== null) throw this.failWith;
    return { rows: this.rows };
  }
}
