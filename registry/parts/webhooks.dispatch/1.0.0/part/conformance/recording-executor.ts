/**
 * A SqlExecutor that records every statement and returns canned rows — used by
 * the DB-free invariants (1, 2, 6-rejection, 7, 8): typed errors, fail-fast
 * validation, SSRF URL-rejection, and the own-table-only assertion. It is NOT
 * used to test persistence/delivery — that would be mocking our own code
 * (docs/02 §4); those invariants run against real Postgres + a real fake
 * receiver in the gated block.
 */
import type { SqlExecutor } from "../src/index";

export class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  /** Rows returned for the next queries (e.g. a canned endpoint / RETURNING row). */
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

/** A canned row that satisfies SELECT_ENDPOINT and the INSERT … RETURNING id calls. */
export function cannedEndpointRow(): Record<string, unknown> {
  return {
    id: "ep_canned",
    owner_id: "owner_1",
    url: "https://example.test/hook",
    secret: "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    event_types: null,
  };
}
