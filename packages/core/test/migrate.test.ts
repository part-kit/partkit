import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIGRATIONS_TABLE,
  NO_TRANSACTION_DIRECTIVE,
  planMigrations,
  runMigrations,
  writeLockfile,
  type LedgerRow,
  type SqlExecutor,
} from "@part-kit/core";

/**
 * Protocol-faithful fake of the node-postgres Client surface migrate uses:
 * it answers to_regclass, tracks the ledger table, and honors BEGIN/COMMIT/
 * ROLLBACK for ledger inserts. Migration bodies are recorded, not executed.
 */
class FakePg implements SqlExecutor {
  ledger: LedgerRow[] = [];
  tableExists = false;
  log: string[] = [];
  failOn: ((sql: string) => boolean) | null = null;
  private tx: LedgerRow[] | null = null;

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const s = sql.trim();
    this.log.push(s);
    if (this.failOn?.(s)) throw new Error(`fake-pg: forced failure on: ${s.slice(0, 40)}`);
    if (s.startsWith("SELECT to_regclass")) {
      return { rows: [{ t: this.tableExists ? MIGRATIONS_TABLE : null }] };
    }
    if (s.startsWith("SELECT pg_advisory_")) return { rows: [] };
    if (s.startsWith(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}`)) {
      this.tableExists = true;
      return { rows: [] };
    }
    if (s.startsWith("SELECT part, seq, name, sha256")) {
      const sorted = [...this.ledger].sort(
        (a, b) => a.part.localeCompare(b.part) || a.seq - b.seq,
      );
      return { rows: sorted.map((r) => ({ ...r })) };
    }
    if (s === "BEGIN") {
      this.tx = [];
      return { rows: [] };
    }
    if (s === "COMMIT") {
      this.ledger.push(...(this.tx ?? []));
      this.tx = null;
      return { rows: [] };
    }
    if (s === "ROLLBACK") {
      this.tx = null;
      return { rows: [] };
    }
    if (s.startsWith(`INSERT INTO ${MIGRATIONS_TABLE}`)) {
      if (!this.tableExists) throw new Error(`fake-pg: relation ${MIGRATIONS_TABLE} does not exist`);
      const [part, seq, name, sha256] = params as [string, number, string, string];
      const row = { part, seq, name, sha256 };
      if (this.tx) this.tx.push(row);
      else this.ledger.push(row);
      return { rows: [] };
    }
    return { rows: [] }; // a migration body
  }
}

const ENTRY = {
  version: "1.0.0",
  adapter: null,
  content_hash: "sha256:0",
  attestation: {
    verified_at: "2026-01-01T00:00:00Z",
    expires: "2026-12-31T00:00:00Z",
    signature: "dev:unsigned",
    result_hash: "sha256:0",
  },
  provenance: "registry:test",
};

async function makeRepo(parts: Record<string, Record<string, string>>): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "partkit-migrate-"));
  await writeLockfile(repo, {
    lockfile_version: 1,
    registry: { source: "test" },
    parts: Object.fromEntries(
      Object.keys(parts).map((name) => [
        name,
        { ...ENTRY, provides: [`${name}@1`] },
      ]),
    ),
  });
  for (const [name, files] of Object.entries(parts)) {
    const dir = path.join(repo, "parts", name, "migrations");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".gitkeep"), "");
    for (const [file, sql] of Object.entries(files)) {
      await writeFile(path.join(dir, file), sql);
    }
  }
  return repo;
}

describe("partkit migrate", () => {
  it("applies pending migrations in order, one transaction each, and records the ledger", async () => {
    const repo = await makeRepo({
      "billing.subscription": { "001-create-subs.sql": "CREATE TABLE billing_subscriptions ()" },
      "audit.log": {
        "001-create-events.sql": "CREATE TABLE audit_events ()",
        "002-add-actor.sql": "ALTER TABLE audit_events ADD actor text",
      },
    });
    const db = new FakePg();
    const res = await runMigrations(repo, db);

    expect(res.applied.map((m) => `${m.part}/${m.name}`)).toEqual([
      "audit.log/001-create-events.sql",
      "audit.log/002-add-actor.sql",
      "billing.subscription/001-create-subs.sql",
    ]);
    expect(db.ledger).toHaveLength(3);
    expect(db.ledger[0]).toMatchObject({ part: "audit.log", seq: 1, name: "001-create-events.sql" });
    expect(db.ledger[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Each body is bracketed by its own BEGIN/COMMIT, with search_path reset
    // before the ledger write (so a migration that moves search_path can't hide it).
    const i = db.log.indexOf("CREATE TABLE audit_events ()");
    expect(db.log[i - 1]).toBe("BEGIN");
    expect(db.log[i + 1]).toBe("RESET search_path");
    expect(db.log[i + 3]).toBe("COMMIT");
  });

  it("is idempotent: a second run applies nothing", async () => {
    const repo = await makeRepo({ "audit.log": { "001-a.sql": "SELECT 1" } });
    const db = new FakePg();
    await runMigrations(repo, db);
    const res = await runMigrations(repo, db);
    expect(res.applied).toHaveLength(0);
    expect(res.alreadyApplied).toBe(1);
  });

  it("hard-fails when an applied migration's bytes changed (tamper detection)", async () => {
    const repo = await makeRepo({ "audit.log": { "001-a.sql": "SELECT 1" } });
    const db = new FakePg();
    await runMigrations(repo, db);
    await writeFile(path.join(repo, "parts", "audit.log", "migrations", "001-a.sql"), "SELECT 2");
    await expect(runMigrations(repo, db)).rejects.toThrow(/no longer matches/);
  });

  it("rejects gaps and duplicate sequence numbers", async () => {
    const gappy = await makeRepo({
      "audit.log": { "001-a.sql": "SELECT 1", "003-c.sql": "SELECT 3" },
    });
    await expect(planMigrations(gappy, new FakePg())).rejects.toThrow(/no gaps/);

    const dupes = await makeRepo({
      "audit.log": { "001-a.sql": "SELECT 1", "1-b.sql": "SELECT 1" },
    });
    await expect(planMigrations(dupes, new FakePg())).rejects.toThrow(/no gaps or duplicates/);
  });

  it("rejects unrecognized files in migrations/", async () => {
    const repo = await makeRepo({ "audit.log": { "setup.sql": "SELECT 1" } });
    await expect(planMigrations(repo, new FakePg())).rejects.toThrow(/NNN-description\.sql/);
  });

  it("fails when the database is ahead of the checkout", async () => {
    const repo = await makeRepo({
      "audit.log": { "001-a.sql": "SELECT 1", "002-b.sql": "SELECT 2" },
    });
    const db = new FakePg();
    await runMigrations(repo, db);
    const older = await makeRepo({ "audit.log": { "001-a.sql": "SELECT 1" } });
    await expect(runMigrations(older, db)).rejects.toThrow(/older than the database/);
  });

  it("runs a no-transaction migration outside BEGIN/COMMIT", async () => {
    const body = `${NO_TRANSACTION_DIRECTIVE}\nCREATE INDEX CONCURRENTLY idx ON audit_events (actor)`;
    const repo = await makeRepo({ "audit.log": { "001-idx.sql": body } });
    const db = new FakePg();
    const res = await runMigrations(repo, db);
    expect(res.applied[0]!.transactional).toBe(false);
    expect(db.log).not.toContain("BEGIN");
    expect(db.ledger).toHaveLength(1);
  });

  it("rolls back the failing migration only; earlier ones stay applied", async () => {
    const repo = await makeRepo({
      "audit.log": { "001-a.sql": "SELECT 'a1'", "002-b.sql": "SELECT 'a2-boom'" },
    });
    const db = new FakePg();
    db.failOn = (sql) => sql.includes("a2-boom");
    await expect(runMigrations(repo, db)).rejects.toThrow(/rolled back/);
    expect(db.log).toContain("ROLLBACK");
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({ part: "audit.log", seq: 1 });

    db.failOn = null;
    const resumed = await runMigrations(repo, db);
    expect(resumed.applied.map((m) => m.name)).toEqual(["002-b.sql"]);
  });

  it("surfaces ledger rows for uninstalled parts and never touches them", async () => {
    const repo = await makeRepo({ "audit.log": { "001-a.sql": "SELECT 1" } });
    const db = new FakePg();
    db.tableExists = true;
    db.ledger.push({ part: "flags.feature", seq: 1, name: "001-x.sql", sha256: "0".repeat(64) });
    const res = await runMigrations(repo, db);
    expect(res.orphaned).toMatchObject([{ part: "flags.feature" }]);
    expect(db.ledger).toHaveLength(2);
  });

  it("dry-run planning works against a database with no ledger table", async () => {
    const repo = await makeRepo({ "audit.log": { "001-a.sql": "SELECT 1" } });
    const db = new FakePg();
    const plan = await planMigrations(repo, db);
    expect(plan.pending).toHaveLength(1);
    expect(db.tableExists).toBe(false);
    expect(db.log.some((s) => s.startsWith("CREATE TABLE"))).toBe(false);
  });
});

// Real-Postgres conformance: same scenarios, no fakes. Gated on a reachable
// database — set PARTKIT_TEST_DATABASE_URL (CI) or run a local Postgres.
const PG_URL = process.env.PARTKIT_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("partkit migrate against real Postgres", () => {
  it("applies, records, re-runs idempotently, and rolls back failures", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    const executor: SqlExecutor = {
      query: async (sql, params) => {
        const res = await client.query(sql, params === undefined ? undefined : [...params]);
        return { rows: res.rows as Record<string, unknown>[] };
      },
    };
    const suffix = `t${process.pid}`;
    try {
      await executor.query(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}, audit_events_${suffix}`);
      const repo = await makeRepo({
        "audit.log": {
          "001-create.sql": `CREATE TABLE audit_events_${suffix} (id int)`,
          "002-boom.sql": "ALTER TABLE no_such_table ADD x int",
        },
      });
      await expect(runMigrations(repo, executor)).rejects.toThrow(/rolled back/);
      const ledger = await executor.query(`SELECT part, seq FROM ${MIGRATIONS_TABLE}`);
      expect(ledger.rows).toEqual([{ part: "audit.log", seq: 1 }]);

      // Fix forward: 001 verifies byte-identical against the ledger and is
      // skipped; the repaired 002 applies. Failure → fix → resume, no repair
      // of the ledger ever needed.
      const fixed = await makeRepo({
        "audit.log": {
          "001-create.sql": `CREATE TABLE audit_events_${suffix} (id int)`,
          "002-fix.sql": `ALTER TABLE audit_events_${suffix} ADD actor text`,
        },
      });
      const resumed = await runMigrations(fixed, executor);
      expect(resumed.applied.map((m) => m.name)).toEqual(["002-fix.sql"]);
      expect(resumed.alreadyApplied).toBe(1);
      const cols = await executor.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
        [`audit_events_${suffix}`],
      );
      expect(cols.rows.map((r) => r["column_name"])).toContain("actor");
    } finally {
      await executor.query(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}, audit_events_${suffix}`);
      await client.end();
    }
  });
});
