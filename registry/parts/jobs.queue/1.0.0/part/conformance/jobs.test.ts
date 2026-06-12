/**
 * Conformance suite for capabilities jobs.queue@1 and jobs.cron@1.
 *
 * Each test names the contract invariant it makes true — the invariant list in
 * contract.json and this file must stay 1:1. This part has no registry adapters
 * (graphile-worker is the wrapped library, not an adapter axis), so the publish
 * script runs the suite once, in the isolated harness with the part's declared
 * graphile-worker installed (plus pg as a conformance test dep).
 *
 * Two blocks:
 *  - DB-free (always on): invariants 1, 2, the config side of 7, and the
 *    own-schema shape of 8 — typed errors, fail-fast validation, invalid-cron
 *    rejection, and the assertion that the enqueue/read seam and the migration
 *    touch only the graphile_worker schema.
 *  - Real graphile-worker + real Postgres (gated on PARTKIT_TEST_DATABASE_URL):
 *    invariants 3–6, the cron side of 7, and 8's migration-no-op + injection —
 *    persistence, processing in both shapes, retry/backoff, the dead-letter,
 *    idempotent enqueue, cron via backfill, and that the worker's boot-time
 *    migration is a no-op against the part's shipped schema.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  drainOnce,
  jobs,
  JobsError,
  runWorker,
  type SqlExecutor,
} from "../src/index";
import { ENQUEUE_SQL, LIST_FAILED_SQL } from "../src/internal/sql";
import { RecordingExecutor } from "./recording-executor";

const TABLE_RE = /\b(from|into|update|join|table)\s+"?([a-z_][a-z0-9_.]*)"?/gi;
function assertGraphileWorkerSchemaOnly(sql: string): void {
  const refs = [...sql.matchAll(TABLE_RE)].map((m) => m[2]!.toLowerCase());
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) expect(ref.startsWith("graphile_worker.")).toBe(true);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
}

// ── DB-free: typed errors, fail-fast validation, invalid cron, own-schema SQL ─
describe("conformance: jobs.queue@1 / jobs.cron@1 · DB-free (no database required)", () => {
  it("invariant 1: a storage failure surfaces as a typed JobsError, connection string redacted", async () => {
    const rec = new RecordingExecutor();
    rec.failWith = new Error("error: password authentication failed; conn=postgres://u:secret@host/db");
    const err = await jobs(rec)
      .enqueue({ task: "send_email" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobsError);
    expect((err as JobsError).code).toBe("storage");
    expect((err as JobsError).message).not.toContain("secret");
    expect((err as JobsError).message).not.toContain("password authentication");
  });

  it("invariant 2: invalid enqueue input fails fast with a typed error and issues zero SQL", async () => {
    const rec = new RecordingExecutor();
    const q = jobs(rec);
    await expect(q.enqueue({ task: "  " })).rejects.toMatchObject({
      name: "JobsError",
      code: "invalid_input",
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.enqueue({ task: "t", payload: [] as any }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(q.enqueue({ task: "t", maxAttempts: 0 })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(q.listFailed({ limit: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 2: invalid worker config fails fast with invalid_input and starts no worker", async () => {
    await expect(
      drainOnce({ connectionString: "", tasks: { t: async () => {} } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      drainOnce({ connectionString: "postgres://x", tasks: {} }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("invariant 7: an invalid cron pattern is rejected at config time with invalid_input", async () => {
    // Reaches graphile-worker's parser (loaded on demand) but never connects.
    const err = await runWorker({
      connectionString: "postgres://nope",
      tasks: { greet: async () => {} },
      cron: [{ task: "greet", pattern: "not a cron pattern" }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobsError);
    expect((err as JobsError).code).toBe("invalid_input");
  });

  it("invariant 8: the enqueue/read seam issues SQL against only the graphile_worker schema", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [{ id: "1", run_at: new Date() }];
    await jobs(rec).enqueue({ task: "send_email", payload: { to: "a@b.c" } });
    rec.rows = [];
    await jobs(rec).listFailed({ task: "send_email", limit: 10 });
    expect(rec.calls.map((c) => c.sql)).toEqual([ENQUEUE_SQL, LIST_FAILED_SQL]);
    for (const { sql } of rec.calls) assertGraphileWorkerSchemaOnly(sql);
  });

  it("invariant 8: the migration installs only the graphile_worker schema (no app/public objects)", async () => {
    const raw = await readFile(
      new URL("../migrations/001-install-graphile-worker.sql", import.meta.url),
      "utf8",
    );
    const ddl = raw.replace(/--[^\n]*/g, "");
    const schemas = [...ddl.matchAll(/create\s+schema\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) =>
      m[1]!.toLowerCase(),
    );
    expect(schemas).toEqual(["graphile_worker"]);
    expect(ddl).not.toMatch(/\bpublic\./i);
    // The 18 ledger rows that make the worker's boot migrate a no-op.
    expect([...ddl.matchAll(/INSERT INTO graphile_worker\.migrations/gi)]).toHaveLength(18);
  });
});

// ── Real graphile-worker + real Postgres ─────────────────────────────────────
const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "conformance: jobs.queue@1 / jobs.cron@1 · real graphile-worker + Postgres",
  () => {
    let client: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };
    let db: SqlExecutor;
    let seq = 0;
    const tok = (label: string): string => `${label}_${process.pid}_${(seq += 1)}`;

    async function countJobs(task: string): Promise<number> {
      const r = await client.query(
        "SELECT count(*)::int AS c FROM graphile_worker.jobs WHERE task_identifier = $1",
        [task],
      );
      return Number(r.rows[0]!["c"]);
    }
    async function nudgeDue(task: string): Promise<void> {
      await client.query(
        "UPDATE graphile_worker._private_jobs SET run_at = now() WHERE id IN (SELECT id FROM graphile_worker.jobs WHERE task_identifier = $1)",
        [task],
      );
    }

    beforeAll(async () => {
      const pg = (await import("pg")).default;
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      client = c;
      // Start from clean, then apply the part's ACTUAL shipped migration exactly
      // as `partkit migrate` does: the whole file as one query inside BEGIN/COMMIT
      // (invariant 8 — the migration installs the schema).
      await c.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
      const migration = await readFile(
        new URL("../migrations/001-install-graphile-worker.sql", import.meta.url),
        "utf8",
      );
      await c.query("BEGIN");
      await c.query(migration);
      await c.query("COMMIT");
      db = {
        query: async (sql, params) => {
          const r = await c.query(sql, params === undefined ? undefined : [...params]);
          return { rows: r.rows as Record<string, unknown>[] };
        },
      };
    });

    afterAll(async () => {
      if (client !== undefined) {
        await client.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
        await client.end();
      }
    });

    it("invariant 8: the worker's boot-time migration is a no-op against the installed schema", async () => {
      const before = await client.query("SELECT count(*)::int AS c FROM graphile_worker.migrations");
      // drainOnce → runOnce → graphile-worker checks migrations on boot.
      await drainOnce({ connectionString: PG_URL!, tasks: { [tok("noop")]: async () => {} } });
      const after = await client.query("SELECT count(*)::int AS c FROM graphile_worker.migrations");
      expect(Number(after.rows[0]!["c"])).toBe(Number(before.rows[0]!["c"]));
      expect(Number(after.rows[0]!["c"])).toBe(18);
    });

    it("invariant 3+4: enqueue persists via the seam and drainOnce runs the handler then removes it", async () => {
      const task = tok("welcome");
      const before = Date.now();
      const ev = await jobs(db).enqueue({ task, payload: { user: 42 } });
      expect(ev.id).toMatch(/^\d+$/);
      expect(ev.task).toBe(task);
      expect(ev.runAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(await countJobs(task)).toBe(1); // immediately visible to a worker

      let got: unknown = null;
      await drainOnce({ connectionString: PG_URL!, tasks: { [task]: async (p) => { got = p; } } });
      expect(got).toEqual({ user: 42 });
      expect(await countJobs(task)).toBe(0); // removed on success
      expect(await jobs(db).listFailed({ task })).toHaveLength(0);
    });

    it("invariant 4: the long-running worker (runWorker) runs the same handler map", async () => {
      const task = tok("daemon");
      await jobs(db).enqueue({ task, payload: { n: 1 } });
      let ran = false;
      const worker = await runWorker({
        connectionString: PG_URL!,
        tasks: { [task]: async () => { ran = true; } },
        pollInterval: 200,
      });
      try {
        expect(await waitFor(() => ran, 15_000)).toBe(true);
      } finally {
        await worker.stop();
        await worker.done.catch(() => {});
      }
      expect(await countJobs(task)).toBe(0);
    }, 20_000);

    it("invariant 5: a failing job retries with backoff up to maxAttempts, then dead-letters", async () => {
      const task = tok("flaky");
      await jobs(db).enqueue({ task, maxAttempts: 2 });
      const fail = { [task]: async () => { throw new Error("boom"); } };

      // Attempt 1: fails, rescheduled into the future (backoff), NOT yet exhausted.
      await drainOnce({ connectionString: PG_URL!, tasks: fail });
      const mid = await client.query(
        "SELECT attempts, max_attempts, run_at FROM graphile_worker.jobs WHERE task_identifier = $1",
        [task],
      );
      expect(Number(mid.rows[0]!["attempts"])).toBe(1);
      expect((mid.rows[0]!["run_at"] as Date).getTime()).toBeGreaterThan(Date.now()); // backoff
      expect(await jobs(db).listFailed({ task })).toHaveLength(0); // not yet a dead-letter

      // Bring the retry due, attempt 2: hits maxAttempts → permanently failed.
      await nudgeDue(task);
      await drainOnce({ connectionString: PG_URL!, tasks: fail });
      const failed = await jobs(db).listFailed({ task });
      expect(failed).toHaveLength(1);
      expect(failed[0]!.attempts).toBe(2);
      expect(failed[0]!.maxAttempts).toBe(2);
      expect(failed[0]!.lastError).toContain("boom");

      // A further drain does not retry it (it stays dead-lettered).
      await nudgeDue(task);
      await drainOnce({ connectionString: PG_URL!, tasks: fail });
      expect((await jobs(db).listFailed({ task }))[0]!.attempts).toBe(2);
    });

    it("invariant 6: enqueuing twice with the same jobKey yields a single job", async () => {
      const task = tok("dedupe");
      const key = tok("key");
      await jobs(db).enqueue({ task, jobKey: key, payload: { v: 1 } });
      await jobs(db).enqueue({ task, jobKey: key, payload: { v: 2 } });
      expect(await countJobs(task)).toBe(1); // one job, not two
    });

    it("invariant 7: a cron schedule runs the recurring task (a missed run is backfilled on startup)", async () => {
      const task = tok("digest");
      // graphile-worker backfills only *since an identifier was first used*, so a
      // brand-new schedule would not fire until the next real minute boundary
      // (up to 60s). Seed a prior execution 5 minutes ago — the honest scenario
      // invariant 7 describes (a worker that was down and restarts): on startup
      // the "every minute" item backfills the missed runs and fires immediately.
      await client.query(
        "INSERT INTO graphile_worker._private_known_crontabs (identifier, known_since, last_execution) VALUES ($1, now() - interval '5 minutes', now() - interval '5 minutes')",
        [task],
      );
      let ran = 0;
      const worker = await runWorker({
        connectionString: PG_URL!,
        tasks: { [task]: async () => { ran += 1; } },
        pollInterval: 200,
        cron: [{ task, pattern: "* * * * *", backfillSeconds: 600 }],
      });
      try {
        expect(await waitFor(() => ran > 0, 15_000)).toBe(true);
      } finally {
        await worker.stop();
        await worker.done.catch(() => {});
      }
    }, 20_000);

    it("invariant 8: SQL metacharacters in a payload round-trip literally and never execute", async () => {
      const task = tok("inject");
      const evil = "'); DROP TABLE graphile_worker._private_jobs; --";
      await jobs(db).enqueue({ task, payload: { note: evil, nested: { x: evil } } });
      let got: unknown = null;
      await drainOnce({ connectionString: PG_URL!, tasks: { [task]: async (p) => { got = p; } } });
      expect(got).toEqual({ note: evil, nested: { x: evil } });
      // The schema is intact — the injection string was data, not SQL.
      const exists = await client.query(
        "SELECT to_regclass('graphile_worker._private_jobs') AS t",
      );
      expect(exists.rows[0]!["t"]).not.toBeNull();
    });
  },
);
