/**
 * Conformance suite for capability audit.log@1.
 *
 * Each test names the contract invariant it makes true — the invariant list in
 * contract.json and this file must stay 1:1. This part has no registry adapters
 * (the database connection is an app seam), so the publish script runs the
 * suite once.
 *
 * Two blocks:
 *  - DB-free (always on): invariants 1, 6, and the own-table assertion of 7 —
 *    typed errors and fail-fast validation, exercised with a recording executor.
 *  - Real Postgres (gated on PARTKIT_TEST_DATABASE_URL): invariants 2–5 and 7's
 *    persistence side — the meaningful ones, run against a real database, never
 *    a mock (docs/02 §4). The part's own shipped migration creates the table.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditLog,
  AuditError,
  type AuditEvent,
  type SqlExecutor,
} from "../src/index";
import { cannedRow, RecordingExecutor } from "./recording-executor";

// ── DB-free: typed errors, fail-fast validation, own-table SQL ───────────────
describe("conformance: audit.log@1 · DB-free (no database required)", () => {
  it("invariant 1: a storage failure surfaces as a typed AuditError, raw error redacted", async () => {
    const rec = new RecordingExecutor();
    rec.failWith = new Error("FATAL: password authentication failed for user 'secret'");
    const log = auditLog(rec);
    const err = await log.append({ action: "user.login" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).code).toBe("storage");
    expect((err as AuditError).message).not.toContain("password authentication failed");
  });

  it("invariant 6: an invalid event fails fast with a typed error and issues zero SQL", async () => {
    const rec = new RecordingExecutor();
    const log = auditLog(rec);
    await expect(log.append({ action: "" })).rejects.toMatchObject({
      name: "AuditError",
      code: "invalid_event",
    });
    await expect(log.append({ action: "a".repeat(1000) })).rejects.toMatchObject({
      code: "invalid_event",
    });
    await expect(
      log.append({ action: "x", metadata: { big: "y".repeat(70_000) } }),
    ).rejects.toMatchObject({ code: "invalid_event" });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 6: an invalid query (bad limit) fails fast with zero SQL", async () => {
    const rec = new RecordingExecutor();
    const log = auditLog(rec);
    await expect(log.query({ limit: 0 })).rejects.toMatchObject({ code: "invalid_query" });
    await expect(log.query({ limit: 99_999 })).rejects.toMatchObject({ code: "invalid_query" });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 7: every statement the part issues targets only audit_events", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [cannedRow()];
    const log = auditLog(rec);
    await log.append({ action: "user.login", actor: "user_1" });
    await log.query({ action: "user.login", limit: 10 });
    expect(rec.calls.length).toBeGreaterThan(0);
    // The only table name any statement may reference is audit_events.
    const TABLE_RE = /\b(from|into|update|join|table)\s+"?([a-z_][a-z0-9_.]*)"?/gi;
    for (const { sql } of rec.calls) {
      for (const m of sql.matchAll(TABLE_RE)) {
        expect(m[2]).toBe("audit_events");
      }
    }
  });
});

// ── Real Postgres: persistence, append-only, query semantics, injection ──────
const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];

interface RecordingPg extends SqlExecutor {
  statements: string[];
}

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "conformance: audit.log@1 · real Postgres",
  () => {
    const schema = `audit_conf_${process.pid}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };
    let db: RecordingPg;
    let seq = 0;
    const tok = (): string => `tok_${process.pid}_${(seq += 1)}`;

    beforeAll(async () => {
      const pg = (await import("pg")).default;
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      client = c;
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema}`);
      // Run the part's ACTUAL shipped migration — conformance covers the SQL
      // the consumer will run, not a hand-rolled table.
      const migration = await readFile(
        new URL("../migrations/001-create-audit-events.sql", import.meta.url),
        "utf8",
      );
      await c.query(migration);

      const statements: string[] = [];
      db = {
        statements,
        query: async (sql, params) => {
          statements.push(sql);
          const r = await c.query(sql, params === undefined ? undefined : [...params]);
          return { rows: r.rows as Record<string, unknown>[] };
        },
      };
    });

    afterAll(async () => {
      if (client !== undefined) {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await client.end();
      }
    });

    beforeEach(() => {
      if (db !== undefined) db.statements.length = 0;
    });

    it("invariant 2: append persists one row, assigns id + occurred_at, and reads back", async () => {
      const action = tok();
      const log = auditLog(db);
      const before = Date.now();
      const ev = await log.append({ actor: "user_42", action, target: "post:7", metadata: { ip: "1.2.3.4" } });

      expect(ev.id).toMatch(/^\d+$/);
      expect(ev.action).toBe(action);
      expect(ev.actor).toBe("user_42");
      expect(ev.target).toBe("post:7");
      expect(ev.metadata).toEqual({ ip: "1.2.3.4" });
      expect(ev.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

      const back = await log.query({ action });
      expect(back).toHaveLength(1);
      expect(back[0]!.id).toBe(ev.id);
    });

    it("invariant 3: the database rejects UPDATE, DELETE, and TRUNCATE (append-only)", async () => {
      const action = tok();
      const log = auditLog(db);
      const ev = await log.append({ action });
      await expect(client.query(`UPDATE audit_events SET action = 'x' WHERE id = ${ev.id}`)).rejects.toThrow(
        /append-only/,
      );
      await expect(client.query(`DELETE FROM audit_events WHERE id = ${ev.id}`)).rejects.toThrow(
        /append-only/,
      );
      await expect(client.query(`TRUNCATE audit_events`)).rejects.toThrow(/append-only/);
      // The row is still there and unchanged.
      const back = await log.query({ action });
      expect(back).toHaveLength(1);
      expect(back[0]!.action).toBe(action);
    });

    it("invariant 4: query is newest-first by id, filters, and paginates by cursor", async () => {
      const action = tok();
      const log = auditLog(db);
      const inserted: AuditEvent[] = [];
      for (let i = 0; i < 5; i += 1) {
        inserted.push(await log.append({ action, actor: `actor_${i}` }));
      }
      const ids = inserted.map((e) => e.id);

      // newest-first
      const all = await log.query({ action });
      expect(all.map((e) => e.id)).toEqual([...ids].reverse());

      // filter by actor
      const one = await log.query({ action, actor: "actor_2" });
      expect(one).toHaveLength(1);
      expect(one[0]!.actor).toBe("actor_2");

      // bounded limit + before cursor — deterministic, no overlap
      const page1 = await log.query({ action, limit: 2 });
      expect(page1.map((e) => e.id)).toEqual([ids[4], ids[3]]);
      const page2 = await log.query({ action, limit: 2, before: page1[1]!.id });
      expect(page2.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    });

    it("invariant 5: SQL metacharacters round-trip literally and never execute (injection)", async () => {
      const action = tok();
      const log = auditLog(db);
      const evil = "'); DROP TABLE audit_events; --";
      const ev = await log.append({
        action,
        actor: evil,
        target: evil,
        metadata: { note: evil, nested: { x: evil } },
      });
      const back = await log.query({ action });
      expect(back).toHaveLength(1);
      expect(back[0]!.actor).toBe(evil);
      expect(back[0]!.metadata).toEqual({ note: evil, nested: { x: evil } });
      // The table still exists — the injection string was data, not SQL.
      const exists = await client.query("SELECT to_regclass('audit_events') AS t");
      expect(exists.rows[0]!.t).not.toBeNull();
    });

    it("invariant 7: against the real database, statements still touch only audit_events", async () => {
      const action = tok();
      const log = auditLog(db);
      await log.append({ action });
      await log.query({ action, limit: 5 });
      const TABLE_RE = /\b(from|into|update|join|table)\s+"?([a-z_][a-z0-9_.]*)"?/gi;
      for (const sql of db.statements) {
        for (const m of sql.matchAll(TABLE_RE)) {
          expect(m[2]).toBe("audit_events");
        }
      }
    });
  },
);
