/**
 * A SqlExecutor that records every statement and returns canned rows — used by
 * the DB-free invariants (1, 5-validation, 6): fail-safe evaluation, fail-fast
 * management validation, and the own-table-only assertion. Persistence / rollout
 * / rule semantics run against real Postgres in the gated block (docs/02 §4).
 */
import type { SqlExecutor } from "../src/index";

export class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  /** Rows returned for the next queries (e.g. a canned flag row). */
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

/** A canned active flag row shaped like the SELECT, so evaluate/getFlag resolve. */
export function cannedFlagRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "f",
    type: "boolean",
    enabled: true,
    default: false,
    rules: [],
    rollout: [],
    archived_at: null,
    ...overrides,
  };
}
