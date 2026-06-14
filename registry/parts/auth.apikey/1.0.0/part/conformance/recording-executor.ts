/**
 * A SqlExecutor that records every statement and returns canned rows — used by
 * the DB-free invariants (1, 3-malformed, 5-header, 7, 8-own-table): typed
 * errors, fail-fast validation, and the own-table-only assertion. It is NOT used
 * to test persistence — that would be mocking our own code (docs/02 §4); the
 * persistence, verify, rotation, and revocation invariants run against real
 * Postgres in the gated block of the suite.
 */
import type { SqlExecutor } from "../src/index";

export class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  /** Rows returned for the next queries (e.g. a canned key row). */
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

/**
 * A canned row shaped like SELECT_BY_PREFIX / RETURNING, so issue/verify/rotate/
 * revoke resolve far enough to issue their SQL. The hash never matches a real
 * secret (verify will reject as invalid) — this row exists only to keep the SQL
 * flowing so the own-table assertion can inspect every statement.
 */
export function cannedKeyRow(): Record<string, unknown> {
  return {
    prefix: "akCanned000000",
    key_hash: Buffer.alloc(32, 1),
    salt: Buffer.alloc(16, 2),
    owner_id: "owner_1",
    name: "canned",
    scopes: ["models.read"],
    created_at: new Date("2026-06-14T00:00:00.000Z"),
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    rotated_at: null,
    grace_until: null,
  };
}
