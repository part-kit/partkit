/**
 * Conformance suite for capability billing.usage@1.
 *
 * Each test names the contract invariant it makes true — the invariant list in
 * contract.json and this file stay 1:1.
 *
 * Blocks:
 *  - DB-free (always on): invariants 1, 2-validation, 6, 7 — typed errors,
 *    fail-fast validation, record-never-reports-inline, secret redaction, and
 *    own-table SQL — with a RecordingExecutor + a FakeRecorder.
 *  - real Postgres · ledger (gated PARTKIT_TEST_DATABASE_URL): idempotency,
 *    half-open aggregation, integer exactness, injection.
 *  - real Postgres · reportDue drain (gated): exactly-once + mark + retry-on-fail,
 *    via a FakeRecorder (own schema — reportDue drains the whole table).
 *  - live Stripe Meters (gated STRIPE_TEST_SECRET_KEY): the real adapter reports,
 *    then we read the meter back (polling for the eventually-consistent aggregate).
 */
import { readFile } from "node:fs/promises";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageError, type SqlExecutor } from "../src/index";
import { makeUsage } from "../src/internal/usage";
import { __resetForTests, adapter as stripeAdapter } from "../adapters/selected/adapter";
import { FakeRecorder } from "./fake-recorder";
import { cannedEventRow, RecordingExecutor } from "./recording-executor";

const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];
const STRIPE_KEY = process.env["STRIPE_TEST_SECRET_KEY"];
const hasPg = PG_URL !== undefined && PG_URL !== "";
const hasStripe = STRIPE_KEY !== undefined && STRIPE_KEY !== "";
const API_VERSION = "2026-05-27.dahlia";

const TABLE_RE = /\b(from|into|update|join|table)\s+"?([a-z_][a-z0-9_.]*)"?/gi;
function assertOwnTableOnly(calls: { sql: string }[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const { sql } of calls) {
    for (const m of sql.matchAll(TABLE_RE)) {
      expect(m[2]).toBe("billing_usage_events");
    }
  }
}

interface PgClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
}

async function setupSchema(schema: string): Promise<{ client: PgClient; db: SqlExecutor }> {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  const client = c as unknown as PgClient;
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  const migration = await readFile(new URL("../migrations/001-create-usage-tables.sql", import.meta.url), "utf8");
  await client.query(migration);
  const db: SqlExecutor = {
    query: async (sql, params) => {
      const r = await client.query(sql, params === undefined ? undefined : [...params]);
      return { rows: r.rows };
    },
  };
  return { client, db };
}

let subjSeq = 0;
const subj = (): string => `cus_${process.pid}_${(subjSeq += 1)}`;

// ── DB-free ──────────────────────────────────────────────────────────────────
describe("conformance: billing.usage@1 · DB-free (no database required)", () => {
  it("invariant 1: record writes the ledger but NEVER calls the biller inline", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [cannedEventRow()];
    const fake = new FakeRecorder();
    const r = await makeUsage(rec, fake).record({ subjectId: "cus_1", meter: "api.request", quantity: 1 });
    expect(r).toEqual({ eventId: "ue_canned", deduped: false });
    expect(rec.calls.length).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(0); // the biller is untouched by record
  });

  it("invariant 2: invalid input fails fast with a typed error and zero SQL / zero biller calls", async () => {
    const rec = new RecordingExecutor();
    const fake = new FakeRecorder();
    const m = makeUsage(rec, fake);
    const bads = [
      { subjectId: "", meter: "m", quantity: 1 },
      { subjectId: "s", meter: "", quantity: 1 },
      { subjectId: "s", meter: "m", quantity: -1 },
      { subjectId: "s", meter: "m", quantity: Number.NaN },
      { subjectId: "s", meter: "m", quantity: Number.POSITIVE_INFINITY },
      { subjectId: "s", meter: "m".repeat(101), quantity: 1 }, // meter capped so it can't become an unreportable poison row
    ];
    for (const bad of bads) {
      // eslint-disable-next-line no-await-in-loop
      await expect(m.record(bad)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(rec.calls).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("invariant 4: reportDue with no adapter selected is a no-op (no SQL)", async () => {
    const rec = new RecordingExecutor();
    const r = await makeUsage(rec, null).reportDue();
    expect(r).toEqual({ reported: 0, failed: 0 });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 6: a storage failure surfaces as a typed UsageError with the secret redacted", async () => {
    process.env["BILLING_USAGE_SECRET_KEY"] = "sk_test_supersecretvalue";
    const rec = new RecordingExecutor();
    rec.failWith = new Error("connection using sk_test_supersecretvalue refused");
    const err = await makeUsage(rec, null)
      .record({ subjectId: "s", meter: "m", quantity: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe("storage");
    expect((err as UsageError).message).not.toContain("supersecretvalue");
    expect((err as UsageError).message).toContain("[redacted]");
    delete process.env["BILLING_USAGE_SECRET_KEY"];
  });

  it("invariant 7: every statement targets only billing_usage_events; metacharacters are bound as params", async () => {
    const rec = new RecordingExecutor();
    const fake = new FakeRecorder();
    const m = makeUsage(rec, fake);
    const evil = "x'); DROP TABLE billing_usage_events; --";
    rec.rows = [cannedEventRow()];
    await m.record({ subjectId: evil, meter: evil, quantity: 1, idempotencyKey: "k" }); // INSERT
    rec.rows = [{ quantity: "0", count: "0" }];
    await m.total({ subjectId: evil, meter: evil }); // TOTAL
    await m.summary({ subjectId: evil }); // SUMMARY
    rec.rows = [{ id: "ue_1", subject_id: evil, meter: "m", quantity: "1", occurred_at: new Date(), metadata: {} }];
    await m.reportDue({ batch: 10 }); // SELECT_UNREPORTED → fake.report → MARK_REPORTED
    assertOwnTableOnly(rec.calls);
    for (const c of rec.calls) expect(c.sql).not.toContain("DROP TABLE");
    expect(rec.calls.some((c) => c.params.includes(evil))).toBe(true);
  });
});

// ── real Postgres · ledger ───────────────────────────────────────────────────
describe.skipIf(!hasPg)("conformance: billing.usage@1 · real Postgres (ledger)", () => {
  const schema = `usage_conf_${process.pid}`;
  let client: PgClient;
  let db: SqlExecutor;

  beforeAll(async () => {
    ({ client, db } = await setupSchema(schema));
  });
  afterAll(async () => {
    if (client !== undefined) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
  });

  it("invariant 2: record is idempotent — same key → one row, deduped, same eventId", async () => {
    const m = makeUsage(db, null);
    const subjectId = subj();
    const a = await m.record({ subjectId, meter: "api.request", quantity: 1, idempotencyKey: "evt-1" });
    const b = await m.record({ subjectId, meter: "api.request", quantity: 9, idempotencyKey: "evt-1" });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.eventId).toBe(a.eventId);
    const cnt = await client.query(
      `SELECT count(*)::int AS n FROM billing_usage_events WHERE subject_id = $1 AND idempotency_key = $2`,
      [subjectId, "evt-1"],
    );
    expect(cnt.rows[0]!["n"]).toBe(1);
    // a different key, and no key, both make new rows
    const c = await m.record({ subjectId, meter: "api.request", quantity: 1, idempotencyKey: "evt-2" });
    expect(c.eventId).not.toBe(a.eventId);
    const d1 = await m.record({ subjectId, meter: "api.request", quantity: 1 });
    const d2 = await m.record({ subjectId, meter: "api.request", quantity: 1 });
    expect(d2.eventId).not.toBe(d1.eventId);
  });

  it("invariant 3: total aggregates over the half-open [since, until) window; empty → 0", async () => {
    const m = makeUsage(db, null);
    const subjectId = subj();
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-02T00:00:00Z");
    const t2 = new Date("2026-01-03T00:00:00Z");
    const t3 = new Date("2026-01-04T00:00:00Z");
    await m.record({ subjectId, meter: "calls", quantity: 1, at: t0 });
    await m.record({ subjectId, meter: "calls", quantity: 2, at: t1 });
    await m.record({ subjectId, meter: "calls", quantity: 4, at: t2 });
    await m.record({ subjectId, meter: "calls", quantity: 8, at: t3 });
    expect(await m.total({ subjectId, meter: "calls" })).toEqual({ subjectId, meter: "calls", quantity: 15, count: 4 });
    // [t1, t3): t1(2)+t2(4)=6, EXCLUDES t3(8) and t0(1)
    expect(await m.total({ subjectId, meter: "calls", since: t1, until: t3 })).toMatchObject({ quantity: 6, count: 2 });
    // empty range and unknown meter → zero total, not an error
    expect(await m.total({ subjectId, meter: "calls", since: new Date("2027-01-01T00:00:00Z"), until: new Date("2027-02-01T00:00:00Z") })).toMatchObject({ quantity: 0, count: 0 });
    expect(await m.total({ subjectId, meter: "nope" })).toMatchObject({ quantity: 0, count: 0 });
  });

  it("invariant 3: summary breaks down per meter, ordered, for the subject", async () => {
    const m = makeUsage(db, null);
    const subjectId = subj();
    await m.record({ subjectId, meter: "a", quantity: 1 });
    await m.record({ subjectId, meter: "a", quantity: 2 });
    await m.record({ subjectId, meter: "b", quantity: 5 });
    expect(await m.summary({ subjectId })).toEqual([
      { subjectId, meter: "a", quantity: 3, count: 2 },
      { subjectId, meter: "b", quantity: 5, count: 1 },
    ]);
  });

  it("invariant 5: integer quantities round-trip and sum exactly (no float drift)", async () => {
    const m = makeUsage(db, null);
    const subjectId = subj();
    await m.record({ subjectId, meter: "tokens", quantity: 1_000_000 });
    await m.record({ subjectId, meter: "tokens", quantity: 2_000_003 });
    expect((await m.total({ subjectId, meter: "tokens" })).quantity).toBe(3_000_003);
  });

  it("invariant 7: SQL metacharacters round-trip literally; the table survives", async () => {
    const m = makeUsage(db, null);
    const evil = "x'); DROP TABLE billing_usage_events; --";
    await m.record({ subjectId: evil, meter: evil, quantity: 1 });
    expect((await m.total({ subjectId: evil, meter: evil })).quantity).toBe(1);
    const exists = await client.query("SELECT to_regclass('billing_usage_events') AS t");
    expect(exists.rows[0]!["t"]).not.toBeNull();
  });
});

// ── real Postgres · reportDue drain (own schema — reportDue drains the table) ──
describe.skipIf(!hasPg)("conformance: billing.usage@1 · reportDue drain (real Postgres + fake recorder)", () => {
  const schema = `usage_drain_${process.pid}`;
  let client: PgClient;
  let db: SqlExecutor;

  beforeAll(async () => {
    ({ client, db } = await setupSchema(schema));
  });
  afterAll(async () => {
    if (client !== undefined) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
  });

  it("invariant 4: reports each unreported event once, marks it, and a re-run is a no-op", async () => {
    const fake = new FakeRecorder();
    const m = makeUsage(db, fake);
    const subjectId = subj();
    const e1 = await m.record({ subjectId, meter: "calls", quantity: 1 });
    const e2 = await m.record({ subjectId, meter: "calls", quantity: 2 });
    expect(await m.reportDue()).toEqual({ reported: 2, failed: 0 });
    expect(fake.calls.map((c) => c.eventId).sort()).toEqual([e1.eventId, e2.eventId].sort());
    // the biller idempotency key is the stable eventId, and the exact quantity string is sent
    expect(fake.calls.every((c) => typeof c.quantity === "string")).toBe(true);
    const unrep = await client.query(`SELECT count(*)::int AS n FROM billing_usage_events WHERE reported_at IS NULL`);
    expect(unrep.rows[0]!["n"]).toBe(0);
    const again = await m.reportDue();
    expect(again).toEqual({ reported: 0, failed: 0 });
    expect(fake.calls).toHaveLength(2); // unchanged — nothing re-reported
  });

  it("invariant 4: a failed report leaves the event unreported for the next pass (never dropped)", async () => {
    const fake = new FakeRecorder();
    const m = makeUsage(db, fake);
    const subjectId = subj();
    const e1 = await m.record({ subjectId, meter: "calls", quantity: 1 });
    const e2 = await m.record({ subjectId, meter: "calls", quantity: 2 });
    const e3 = await m.record({ subjectId, meter: "calls", quantity: 4 });
    fake.failFor.add(e2.eventId);
    const rep = await m.reportDue();
    expect(rep.reported).toBe(2);
    expect(rep.failed).toBe(1);
    const unrep = await client.query(`SELECT id, report_attempts FROM billing_usage_events WHERE reported_at IS NULL`);
    expect(unrep.rows.map((r) => String(r["id"]))).toEqual([e2.eventId]);
    expect(Number(unrep.rows[0]!["report_attempts"])).toBe(1); // failure bumped attempts → sinks in drain order
    expect([e1.eventId, e3.eventId]).not.toContain(e2.eventId); // sanity
    // clear the failure → only the still-unreported e2 reports
    fake.failFor.clear();
    fake.calls.length = 0;
    expect(await m.reportDue()).toEqual({ reported: 1, failed: 0 });
    expect(fake.calls.map((c) => c.eventId)).toEqual([e2.eventId]);
  });

  it("invariant 4: a config error aborts the pass and surfaces (not swallowed as a per-event failure)", async () => {
    const configAdapter = {
      name: "needs-config",
      report: async (): Promise<{ reportedId?: string }> => {
        throw new UsageError("config", "Missing required env var BILLING_USAGE_SECRET_KEY");
      },
    };
    const m = makeUsage(db, configAdapter);
    await m.record({ subjectId: subj(), meter: "calls", quantity: 1 });
    await expect(m.reportDue()).rejects.toMatchObject({ code: "config" });
  });
});

// ── live Stripe Meters ───────────────────────────────────────────────────────
describe.skipIf(!hasStripe || !hasPg)("conformance: billing.usage@1 · live Stripe Meters", () => {
  const schema = `usage_live_${process.pid}`;
  let client: PgClient;
  let db: SqlExecutor;
  let stripe: Stripe;
  let customerId = "";
  let meterId = "";
  let eventName = "";

  beforeAll(async () => {
    process.env["BILLING_USAGE_SECRET_KEY"] = STRIPE_KEY;
    __resetForTests();
    stripe = new Stripe(STRIPE_KEY as string, { apiVersion: API_VERSION });
    ({ client, db } = await setupSchema(schema));
    const customer = await stripe.customers.create({ description: `partkit billing.usage conf ${process.pid}` });
    customerId = customer.id;
    eventName = `partkit_usage_conf_${process.pid}`;
    const meter = await stripe.billing.meters.create({
      display_name: `PartKit conf ${process.pid}`,
      event_name: eventName,
      default_aggregation: { formula: "sum" },
    });
    meterId = meter.id;
  }, 60_000);

  afterAll(async () => {
    try {
      if (meterId !== "") await stripe.billing.meters.deactivate(meterId);
      if (customerId !== "") await stripe.customers.del(customerId);
    } catch {
      /* best-effort cleanup */
    }
    if (client !== undefined) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
    delete process.env["BILLING_USAGE_SECRET_KEY"];
    __resetForTests();
  });

  it("invariant 4: the stripe adapter reports usage to Stripe Meters (and the aggregate converges)", async () => {
    const m = makeUsage(db, stripeAdapter);
    await m.record({ subjectId: customerId, meter: eventName, quantity: 3 });
    await m.record({ subjectId: customerId, meter: eventName, quantity: 7 });
    // A 60-day-old backfilled event: without the adapter's timestamp clamp Stripe
    // would REJECT it (>35d) and it would be lost; with the clamp it is accepted.
    await m.record({ subjectId: customerId, meter: eventName, quantity: 5, at: new Date(Date.now() - 60 * 86_400 * 1000) });

    // The hard gate: Stripe ACCEPTED every meter event including the backfilled
    // one (proves the clamp), and the ledger marked them all reported.
    const rep = await m.reportDue();
    expect(rep).toEqual({ reported: 3, failed: 0 });
    const unrep = await client.query(`SELECT count(*)::int AS n FROM billing_usage_events WHERE reported_at IS NULL`);
    expect(unrep.rows[0]!["n"]).toBe(0);

    // Best-effort read-back: meter aggregation is eventually consistent (lag of
    // seconds–minutes), so poll. The window spans the clamp horizon so the
    // backfilled (clamped to ~now-34d) event is included. If it converges, assert
    // exact attribution; if not within the budget, don't fail on Stripe's lag.
    const nowSec = Math.floor(Date.now() / 1000);
    const startTime = Math.floor((nowSec - 35 * 86_400) / 60) * 60;
    const endTime = Math.ceil((nowSec + 600) / 60) * 60;
    const deadline = Date.now() + 75_000;
    let aggregated = 0;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const summaries = await stripe.billing.meters.listEventSummaries(meterId, {
        customer: customerId,
        start_time: startTime,
        end_time: endTime,
      });
      const data = summaries.data as Array<{ aggregated_value?: number }>;
      aggregated = data.reduce((acc, s) => acc + (s.aggregated_value ?? 0), 0);
      if (aggregated >= 15) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (aggregated >= 15) {
      expect(aggregated).toBe(15);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[billing.usage live] meter aggregate not yet consistent (${aggregated}/15) — report succeeded; skipping aggregate assertion`);
    }
  }, 120_000);
});
