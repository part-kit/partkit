/**
 * Conformance suite for capability admin.crud@1 (RFC 0004).
 *
 * Each test names the contract invariant it makes true — the invariant list in
 * contract.json and this file must stay 1:1. admin.crud has no registry adapters
 * and no runtime deps, so the publish script runs the suite once in-repo.
 *
 * The suite administers a FICTIONAL part ("fixtures.widgets") that admin.crud has
 * no code for — proving it operates purely off the declared reads + the seam +
 * mutators (contract invariant 6).
 *
 * Two blocks:
 *  - DB-free (always on): invariants 1, 3, 4, the SQL-shape side of 2, and the
 *    identifier/parameterization side of 5 — typed errors, unknown-resource,
 *    the write boundary, the column projection, and injection-safety.
 *  - Real Postgres (gated on PARTKIT_TEST_DATABASE_URL): the data side of 2 (a
 *    redacted column is never fetched), 5's injection round-trip, and a real
 *    mutator-dispatched write.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  AdminError,
  collectReads,
  type ResourceDeclaration,
  type SqlExecutor,
} from "../src/index";
import { RecordingExecutor } from "./recording-executor";

const WIDGETS = "admin_fixture_widgets";
const LOGS = "admin_fixture_logs";

/** A fictional part's declared read surface — admin.crud has no code for it. */
function fixtureResources(): ResourceDeclaration[] {
  return [
    {
      part: "fixtures.widgets",
      reads: {
        [WIDGETS]: {
          label: "Widgets",
          primary_key: "id",
          order_by: "created_at desc",
          columns: [
            { name: "id", type: "uuid" },
            { name: "name", type: "string", label: "Name" },
            { name: "secret_token", type: "string", redact: true },
            { name: "created_at", type: "timestamp" },
          ],
          mutations: { update: "renameWidget", delete: "deleteWidget" },
        },
        [LOGS]: {
          label: "Logs",
          primary_key: "id",
          columns: [
            { name: "id", type: "number" },
            { name: "message", type: "string" },
          ],
          // no mutations ⇒ read-only
        },
      },
    },
  ];
}

// ── DB-free ──────────────────────────────────────────────────────────────────
describe("conformance: admin.crud@1 · DB-free (no database required)", () => {
  it("invariant 1: a storage failure surfaces as a typed AdminError, raw error redacted", async () => {
    const rec = new RecordingExecutor();
    rec.failWith = new Error("FATAL: password authentication failed for user 'secret'");
    const a = admin({ resources: fixtureResources(), db: rec });
    const err = await a.list(WIDGETS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminError);
    expect((err as AdminError).code).toBe("storage");
    expect((err as AdminError).message).not.toContain("password authentication failed");
  });

  it("invariant 2: reads project only declared, non-redacted columns (the redacted column is never selected)", async () => {
    const rec = new RecordingExecutor();
    const a = admin({ resources: fixtureResources(), db: rec });
    await a.list(WIDGETS, { limit: 10 });
    await a.get(WIDGETS, { id: "w1" });
    expect(rec.calls).toHaveLength(2);
    for (const { sql } of rec.calls) {
      expect(sql).toContain('"id"');
      expect(sql).toContain('"name"');
      expect(sql).toContain('"created_at"');
      // the redacted column is never in the projection
      expect(sql).not.toContain("secret_token");
    }
    // resources() also hides the redacted column from the UI metadata
    const widgets = a.resources().find((r) => r.table === WIDGETS)!;
    expect(widgets.columns.map((c) => c.name)).toEqual(["id", "name", "created_at"]);
  });

  it("invariant 3: an undeclared resource fails with unknown_resource and issues zero SQL", async () => {
    const rec = new RecordingExecutor();
    const a = admin({ resources: fixtureResources(), db: rec });
    await expect(a.list("not_a_resource")).rejects.toMatchObject({
      name: "AdminError",
      code: "unknown_resource",
    });
    await expect(a.get("auth_user", { id: "x" })).rejects.toMatchObject({
      code: "unknown_resource",
    });
    expect(rec.calls).toHaveLength(0);

    // a part that declares no reads contributes no resources (no raw fallback)
    const none = collectReads([{ part: "audit.log", data_ownership: { reads: undefined } }]);
    expect(none).toHaveLength(0);
    expect(admin({ resources: none, db: rec }).resources()).toHaveLength(0);
  });

  it("invariant 4: writes dispatch to mutators only — never SQL; read-only and missing mutators are typed", async () => {
    const rec = new RecordingExecutor();

    // read-only resource (no mutations) → read_only, and zero SQL
    const ro = admin({ resources: fixtureResources(), db: rec });
    await expect(ro.remove(LOGS, { id: 1 })).rejects.toMatchObject({ code: "read_only" });
    await expect(ro.create(LOGS, { message: "x" })).rejects.toMatchObject({ code: "read_only" });

    // mutation declared but no mutator wired → no_mutator
    await expect(ro.remove(WIDGETS, { id: "w1" })).rejects.toMatchObject({ code: "no_mutator" });

    // wired mutator IS called (with the key), and NO write SQL is issued
    const calls: unknown[] = [];
    const a = admin({
      resources: fixtureResources(),
      db: rec,
      mutators: {
        "fixtures.widgets": {
          deleteWidget: (args) => {
            calls.push(args);
            return { deleted: true };
          },
        },
      },
    });
    const result = await a.remove(WIDGETS, { id: "w1" });
    expect(result).toEqual({ deleted: true });
    expect(calls).toEqual([{ key: { id: "w1" } }]);
    expect(rec.calls).toHaveLength(0); // admin.crud issued no SQL for the write

    // a mutator's OWN typed error propagates UNCHANGED (the part's invariant holds)
    class TenancyError extends Error {
      code = "last_owner";
    }
    const guarded = admin({
      resources: fixtureResources(),
      mutators: {
        "fixtures.widgets": {
          deleteWidget: () => {
            throw new TenancyError("cannot remove the last owner");
          },
        },
      },
    });
    const err = await guarded.remove(WIDGETS, { id: "w1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenancyError);
    expect(err).not.toBeInstanceOf(AdminError);
    expect((err as TenancyError).code).toBe("last_owner");
  });

  it("invariant 5: identifiers are validated/quoted and values parameterized — no injection", async () => {
    const rec = new RecordingExecutor();

    // a malformed reads declaration (a non-identifier column) is rejected, zero SQL
    const evilResources: ResourceDeclaration[] = [
      {
        part: "evil.part",
        reads: {
          evil_table: {
            primary_key: "id",
            columns: [{ name: "id", type: "uuid" }, { name: "name); DROP TABLE x; --", type: "string" }],
          },
        },
      },
    ];
    await expect(
      admin({ resources: evilResources, db: rec }).list("evil_table"),
    ).rejects.toMatchObject({ code: "invalid_contract" });
    expect(rec.calls).toHaveLength(0);

    // a key value carrying SQL metacharacters is bound as a parameter, not interpolated
    rec.rows = [];
    const a = admin({ resources: fixtureResources(), db: rec });
    const evilId = "'); DROP TABLE admin_fixture_widgets; --";
    await a.get(WIDGETS, { id: evilId });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.sql).toContain('"id" = $1');
    expect(rec.calls[0]!.params).toEqual([evilId]); // the metacharacters are DATA
  });

  it("invariant 6: admin.crud administers a part it has no code for, purely from declarations", async () => {
    // No import of any "fixtures.widgets" part exists — the whole config is data.
    const a = admin({ resources: fixtureResources() });
    const infos = a.resources();
    expect(infos.map((r) => r.table).sort()).toEqual([LOGS, WIDGETS].sort());
    const widgets = infos.find((r) => r.table === WIDGETS)!;
    expect(widgets.part).toBe("fixtures.widgets");
    expect(widgets.primaryKey).toEqual(["id"]);
    expect(widgets.actions).toEqual({ create: false, update: true, delete: true });
    expect(infos.find((r) => r.table === LOGS)!.actions).toEqual({
      create: false,
      update: false,
      delete: false,
    });
  });
});

// ── Real Postgres ────────────────────────────────────────────────────────────
const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "conformance: admin.crud@1 · real Postgres",
  () => {
    const schema = `admin_crud_conf_${process.pid}`;
    let client: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };
    let db: SqlExecutor;

    beforeAll(async () => {
      const pg = (await import("pg")).default;
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      client = c;
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema}`);
      await c.query(
        `CREATE TABLE ${WIDGETS} (id text PRIMARY KEY, name text NOT NULL, secret_token text, created_at timestamptz NOT NULL DEFAULT now())`,
      );
      await c.query(
        `INSERT INTO ${WIDGETS} (id, name, secret_token) VALUES ('w1','Alpha','SECRET_ALPHA'), ('w2','Beta','SECRET_BETA')`,
      );
      db = {
        query: async (sql, params) => {
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

    it("invariant 2: a redacted column's value is never fetched, even though it exists in the row", async () => {
      const a = admin({ resources: fixtureResources(), db });
      const rows = await a.list(WIDGETS);
      expect(rows).toHaveLength(2);
      // newest-first by created_at — both share ~now, so just check shape
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["created_at", "id", "name"]);
        expect("secret_token" in row).toBe(false);
      }
      // the secret never appears anywhere in the result
      expect(JSON.stringify(rows)).not.toContain("SECRET_");

      const one = await a.get(WIDGETS, { id: "w1" });
      expect(one?.["name"]).toBe("Alpha");
      expect("secret_token" in (one ?? {})).toBe(false);

      const missing = await a.get(WIDGETS, { id: "nope" });
      expect(missing).toBeNull();
    });

    it("invariant 5: a key with SQL metacharacters round-trips as data; the table survives", async () => {
      const a = admin({ resources: fixtureResources(), db });
      const evil = "'); DROP TABLE admin_fixture_widgets; --";
      const row = await a.get(WIDGETS, { id: evil });
      expect(row).toBeNull(); // no such id — and no injection
      const exists = await client.query(`SELECT to_regclass('${schema}.${WIDGETS}') AS t`);
      expect(exists.rows[0]!["t"]).not.toBeNull();
    });

    it("invariant 4: a write flows through the mutator (real delete), not admin SQL", async () => {
      // The app wires deleteWidget to the part's real mutator; here it deletes
      // through the client to prove admin.crud routes the write, never issues it.
      const a = admin({
        resources: fixtureResources(),
        db,
        mutators: {
          "fixtures.widgets": {
            deleteWidget: async (args) => {
              await client.query(`DELETE FROM ${WIDGETS} WHERE id = $1`, [args.key!["id"]]);
              return { ok: true };
            },
          },
        },
      });
      await a.remove(WIDGETS, { id: "w2" });
      const left = await a.list(WIDGETS);
      expect(left.map((r) => r["id"])).not.toContain("w2");
    });
  },
);
