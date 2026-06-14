/**
 * Conformance suite for capability billing.subscription@1 (stripe adapter).
 *
 * Four blocks, gated by environment (the audit.log / jobs.queue pattern):
 *  A — DB-free (always): validation, typed+redacted errors, write boundary,
 *      own-tables-only SQL. Uses a RecordingExecutor + a fake adapter.
 *  B — offline signature (always): the REAL stripe adapter's HMAC verifier,
 *      exercised with locally-signed payloads (no network, no Stripe key),
 *      cross-checked against the SDK's own signer.
 *  C — idempotency / state (real Postgres, PARTKIT_TEST_DATABASE_URL): the
 *      shipped migration + webhook-derived mirror, idempotent under replay.
 *  D — live Stripe test mode (STRIPE_TEST_SECRET_KEY + PG): real checkout +
 *      a real subscription mirrored from a (locally re-signed) event.
 *
 * Each test names the contract invariant it makes true (contract.json ↔ this
 * file stay 1:1). DB-free + offline blocks run first so they attest even with
 * no database and no Stripe key.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { adapter, __resetForTests } from "../adapters/selected/adapter";
import { BillingError } from "../src/internal/errors";
import { makeBilling, makeWebhookHandler } from "../src/internal/billing";
import type {
  BillingAdapter,
  CheckoutArgs,
  CheckoutSession,
  NeutralBillingEvent,
  PlanCatalog,
  ProrationBehavior,
  RemoteSubscription,
} from "../src/internal/types";
import { RecordingExecutor } from "./recording-executor";
import { signStripe } from "./fake-sender";

const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];
const STRIPE_KEY = process.env["STRIPE_TEST_SECRET_KEY"];
const TEST_PRICE_ID = process.env["STRIPE_TEST_PRICE_ID"];
const hasPg = PG_URL !== undefined && PG_URL !== "";
const hasStripe = STRIPE_KEY !== undefined && STRIPE_KEY !== "" && TEST_PRICE_ID !== undefined && TEST_PRICE_ID !== "";

const WEBHOOK_SECRET = "whsec_conformance_test_secret_value";

const catalog: PlanCatalog = {
  get: (id) => (id === "pro" ? { id: "pro", stripePriceId: "price_pro_test", label: "Pro" } : null),
  list: () => [{ id: "pro", stripePriceId: "price_pro_test", label: "Pro" }],
};

const CANNED_REMOTE: RemoteSubscription = {
  vendorCustomerId: "cus_fake",
  vendorSubscriptionId: "sub_fake",
  vendorPriceId: "price_pro_test",
  status: "active",
  currentPeriodEndEpoch: 1_900_000_000,
  cancelAtPeriodEnd: false,
  userId: "u1",
  planId: "pro",
};

class FakeAdapter implements BillingAdapter {
  readonly name = "fake";
  readonly calls: string[] = [];
  nextEvent: NeutralBillingEvent | null = null;
  failCheckout: Error | null = null;

  async createCheckout(_args: CheckoutArgs): Promise<CheckoutSession> {
    this.calls.push("createCheckout");
    if (this.failCheckout !== null) throw this.failCheckout;
    return { id: "cs_fake", url: "https://stripe.test/checkout/cs_fake" };
  }
  async setCancelAtPeriodEnd(_id: string, cancel: boolean): Promise<RemoteSubscription> {
    this.calls.push("setCancelAtPeriodEnd");
    return { ...CANNED_REMOTE, cancelAtPeriodEnd: cancel };
  }
  async changePlan(_id: string, price: string, _p: ProrationBehavior): Promise<RemoteSubscription> {
    this.calls.push("changePlan");
    return { ...CANNED_REMOTE, vendorPriceId: price };
  }
  verifyAndParseWebhook(): NeutralBillingEvent {
    this.calls.push("verifyAndParseWebhook");
    if (this.nextEvent === null) throw new Error("no event configured");
    return this.nextEvent;
  }
}

function subEvent(o: {
  evtId: string;
  type?: string;
  subId?: string;
  userId?: string | null;
  planId?: string | null;
  status?: string;
  priceId?: string;
  periodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  created?: number;
}): string {
  const metadata: Record<string, string> = {};
  if (o.userId !== null && o.userId !== undefined) metadata["user_id"] = o.userId;
  if (o.planId !== null && o.planId !== undefined) metadata["plan_id"] = o.planId;
  return JSON.stringify({
    id: o.evtId,
    type: o.type ?? "customer.subscription.created",
    created: o.created ?? 1_700_000_000,
    data: {
      object: {
        id: o.subId ?? "sub_1",
        status: o.status ?? "active",
        customer: "cus_1",
        cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
        metadata,
        items: { data: [{ id: "si_1", current_period_end: o.periodEnd ?? 1_900_000_000, price: { id: o.priceId ?? "price_pro_test" } }] },
      },
    },
  });
}

/* ─────────────────────────────── Block A — DB-free ─────────────────────────────── */

describe("billing.subscription@1 · DB-free (no database, no Stripe)", () => {
  it("invariant 1: importing performed no I/O; billing is a usable factory", () => {
    expect(typeof makeBilling).toBe("function");
  });

  it("invariant 2: blank/unknown planId or empty userId fails fast with invalid_input and ZERO SQL + ZERO vendor calls", async () => {
    const rec = new RecordingExecutor();
    const fake = new FakeAdapter();
    const b = makeBilling(rec, fake);
    await expect(
      b.createCheckout({ userId: "", planId: "pro", catalog, successUrl: "s", cancelUrl: "c" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      b.createCheckout({ userId: "u1", planId: "nope", catalog, successUrl: "s", cancelUrl: "c" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(rec.calls.length).toBe(0);
    expect(fake.calls.length).toBe(0);
  });

  it("invariant 4 (a): createCheckout with valid input calls the vendor but writes NO subscription row", async () => {
    const rec = new RecordingExecutor();
    const fake = new FakeAdapter();
    const b = makeBilling(rec, fake);
    const session = await b.createCheckout({ userId: "u1", planId: "pro", catalog, successUrl: "s", cancelUrl: "c" });
    expect(session.url).toContain("checkout");
    expect(fake.calls).toContain("createCheckout");
    expect(rec.calls.length).toBe(0); // no DB write — the mirror is webhook-derived
  });

  it("invariant 1: a storage error surfaces as a typed BillingError with secrets redacted", async () => {
    process.env["BILLING_SECRET_KEY"] = "sk_test_topsecretvalue123";
    const rec = new RecordingExecutor();
    rec.failWith = new Error("connect failed for sk_test_topsecretvalue123 at host");
    const b = makeBilling(rec, new FakeAdapter());
    const err = await b.getSubscription("u1").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(BillingError);
    expect((err as BillingError).code).toBe("storage");
    expect((err as Error).message).not.toContain("sk_test_topsecretvalue123");
    expect((err as Error).message).toContain("[redacted]");
    delete process.env["BILLING_SECRET_KEY"];
  });

  it("invariant 7: an upsert driven by a webhook targets ONLY billing_ tables and binds every value as a parameter (no interpolation)", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [{ id: "row1" }]; // so the event-insert reads "fresh" and the upsert proceeds
    const fake = new FakeAdapter();
    fake.nextEvent = {
      id: "evt_a",
      rawType: "customer.subscription.created",
      action: { kind: "subscription.created", subscription: { ...CANNED_REMOTE, userId: "u'; DROP TABLE billing_subscriptions; --" } },
    };
    const b = makeBilling(rec, fake);
    await b.ingestWebhook({ rawBody: new Uint8Array(), signatureHeader: "sig", nowEpochSeconds: 1 });
    expect(rec.calls.length).toBeGreaterThan(0);
    for (const c of rec.calls) {
      expect(c.sql).toMatch(/billing_(subscriptions|events)/);
      expect(c.sql).not.toMatch(/\b(auth_|users|drop\s+table)\b/i);
    }
    // The injection string was bound as a param, never spliced into SQL text.
    const upsert = rec.calls.find((c) => c.sql.includes("INSERT INTO billing_subscriptions"));
    expect(upsert).toBeDefined();
    expect(upsert?.params).toContain("u'; DROP TABLE billing_subscriptions; --");
    expect(upsert?.sql).not.toContain("DROP TABLE billing_subscriptions; --");
  });

  it("invariant 2: cancel/changePlan on an unknown subscriptionId fail not_found, with no write", async () => {
    const rec = new RecordingExecutor(); // rows: [] → getById returns null
    const b = makeBilling(rec, new FakeAdapter());
    await expect(b.cancelAtPeriodEnd({ subscriptionId: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(
      b.changePlan({ subscriptionId: "nope", newPlanId: "pro", catalog }),
    ).rejects.toMatchObject({ code: "not_found" });
    // only lookups happened — no INSERT/UPDATE
    expect(rec.calls.some((c) => /\b(insert|update)\b/i.test(c.sql))).toBe(false);
  });

  it("invariant 4: cancel/reactivate/changePlan return the optimistic projection and write NO mirror row", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [
      {
        id: "s1", user_id: "u1", stripe_customer_id: "cus", stripe_subscription_id: "sub_x",
        stripe_price_id: "price_pro_test", plan_id: "pro", status: "active",
        current_period_end: null, cancel_at_period_end: false, created_at: null, updated_at: null,
      },
    ];
    const fake = new FakeAdapter();
    const b = makeBilling(rec, fake);

    const cancelled = await b.cancelAtPeriodEnd({ subscriptionId: "s1" });
    expect(cancelled.cancelAtPeriodEnd).toBe(true);
    expect(fake.calls).toContain("setCancelAtPeriodEnd");

    const changed = await b.changePlan({ subscriptionId: "s1", newPlanId: "pro", catalog });
    expect(changed.stripePriceId).toBe("price_pro_test");
    expect(fake.calls).toContain("changePlan");

    // the mirror is webhook-derived — these lifecycle calls never write it
    expect(rec.calls.some((c) => /\b(insert|update)\b/i.test(c.sql))).toBe(false);
  });
});

/* ───────────────────────── Block B — offline signature ───────────────────────── */

describe("billing.subscription@1 · webhook signature (offline, real verifier)", () => {
  beforeAll(() => {
    process.env["BILLING_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  });
  afterAll(() => {
    delete process.env["BILLING_WEBHOOK_SECRET"];
  });

  const now = 1_700_000_000;
  const payload = subEvent({ evtId: "evt_b", userId: "u1" });

  it("invariant 5: a correctly-signed payload verifies and parses to the event", () => {
    const header = signStripe(payload, WEBHOOK_SECRET, now);
    const event = adapter.verifyAndParseWebhook(new TextEncoder().encode(payload), header, now);
    expect(event.id).toBe("evt_b");
    expect(event.action.kind).toBe("subscription.created");
  });

  it("invariant 5: a decoy v1 alongside the real one still verifies (key rotation)", () => {
    const header = signStripe(payload, WEBHOOK_SECRET, now, true);
    expect(() => adapter.verifyAndParseWebhook(new TextEncoder().encode(payload), header, now)).not.toThrow();
  });

  it("invariant 5: tampered body, wrong secret, and missing elements are rejected as invalid_signature", () => {
    const good = signStripe(payload, WEBHOOK_SECRET, now);
    const tampered = `${payload} `;
    expect(() => adapter.verifyAndParseWebhook(new TextEncoder().encode(tampered), good, now)).toThrowError(/signature/i);
    const wrong = signStripe(payload, "whsec_wrong", now);
    expect(() => adapter.verifyAndParseWebhook(new TextEncoder().encode(payload), wrong, now)).toThrowError(/signature/i);
    for (const h of ["", `t=${now}`, "v1=abc"]) {
      expect(() => adapter.verifyAndParseWebhook(new TextEncoder().encode(payload), h, now)).toThrow(BillingError);
    }
  });

  it("invariant 5: a signed timestamp outside the ±300s window is rejected as timestamp_out_of_window", () => {
    const header = signStripe(payload, WEBHOOK_SECRET, now);
    const err = (() => {
      try {
        adapter.verifyAndParseWebhook(new TextEncoder().encode(payload), header, now + 10 * 60);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BillingError);
    expect((err as BillingError).code).toBe("timestamp_out_of_window");
  });

  it("invariant 5: our raw verifier agrees with Stripe's own signer (wire-format oracle)", () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET, timestamp: now });
    expect(() => adapter.verifyAndParseWebhook(new TextEncoder().encode(payload), header, now)).not.toThrow();
  });

  it("invariant 5: the webhook route maps to the Stripe retry contract — 400 on bad signature, 500 on storage failure", async () => {
    const rec = new RecordingExecutor();
    const route = makeWebhookHandler(rec, adapter);
    // bad signature → 400 (Stripe must not redeliver), and nothing touched the DB
    const bad = new Request("http://x/api/webhooks/billing", {
      method: "POST",
      body: payload,
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
    });
    expect((await route(bad)).status).toBe(400);
    expect(rec.calls.length).toBe(0);
    // valid signature but storage fails → 500 (safe redelivery). Sign with the
    // current time so the ±300s window passes against the route's wall clock.
    const wnow = Math.floor(Date.now() / 1000);
    const freshPayload = subEvent({ evtId: "evt_route500", userId: "u1", status: "active" });
    rec.failWith = new Error("db unavailable");
    const good = new Request("http://x/api/webhooks/billing", {
      method: "POST",
      body: freshPayload,
      headers: { "stripe-signature": signStripe(freshPayload, WEBHOOK_SECRET, wnow) },
    });
    expect((await route(good)).status).toBe(500);
  });
});

/* ───────────────────── Block C — idempotency / state (real PG) ───────────────────── */

describe.skipIf(!hasPg)("billing.subscription@1 · idempotency + state (real Postgres)", () => {
  let client: import("pg").Client;
  let db: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  const schema = `billing_conf_${process.pid}`;

  beforeAll(async () => {
    process.env["BILLING_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
    const { Client } = await import("pg");
    client = new Client({ connectionString: PG_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const migration = await readFile(new URL("../migrations/001-create-billing-tables.sql", import.meta.url), "utf8");
    await client.query(migration);
    db = { query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows }) };
  });
  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
    delete process.env["BILLING_WEBHOOK_SECRET"];
  });

  async function ingest(payload: string, now = 1_700_000_000) {
    return makeBilling(db, adapter).ingestWebhook({
      rawBody: new TextEncoder().encode(payload),
      signatureHeader: signStripe(payload, WEBHOOK_SECRET, now),
      nowEpochSeconds: now,
    });
  }

  it("invariant 4 (b) + 8: a verified subscription.created upserts the mirror and entitlement is true for active", async () => {
    const r = await ingest(subEvent({ evtId: "evt_c1", subId: "sub_c1", userId: "uc1", planId: "pro", status: "active" }));
    expect(r.applied).toBe(true);
    const sub = await makeBilling(db, adapter).getSubscription("uc1");
    expect(sub?.stripeSubscriptionId).toBe("sub_c1");
    expect(sub?.planId).toBe("pro");
    expect(sub?.entitled).toBe(true);
  });

  it("invariant 3: a redelivered event id (same evt_) records and applies at most once", async () => {
    const payload = subEvent({ evtId: "evt_c2", subId: "sub_c2", userId: "uc2", status: "active" });
    const first = await ingest(payload);
    const second = await ingest(payload);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM billing_subscriptions WHERE stripe_subscription_id = $1`, ["sub_c2"]);
    expect(rows[0]?.["n"]).toBe(1);
    const events = await db.query(`SELECT count(*)::int AS n FROM billing_events WHERE stripe_event_id = $1`, ["evt_c2"]);
    expect(events.rows[0]?.["n"]).toBe(1);
  });

  it("invariant 8: status transitions flip entitlement (active → canceled ⇒ not entitled)", async () => {
    await ingest(subEvent({ evtId: "evt_c3a", subId: "sub_c3", userId: "uc3", status: "active" }));
    await ingest(subEvent({ evtId: "evt_c3b", subId: "sub_c3", userId: "uc3", status: "canceled", type: "customer.subscription.updated" }));
    const sub = await makeBilling(db, adapter).getSubscription("uc3");
    expect(sub?.status).toBe("canceled");
    expect(sub?.entitled).toBe(false);
  });

  it("invariant 7: SQL metacharacters in a user id round-trip literally and never execute (injection)", async () => {
    const evil = "uc4'; DROP TABLE billing_subscriptions; --";
    await ingest(subEvent({ evtId: "evt_c4", subId: "sub_c4", userId: evil, status: "active" }));
    const sub = await makeBilling(db, adapter).getSubscription(evil);
    expect(sub?.userId).toBe(evil);
    // the table still exists and is queryable — the injection never executed
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM billing_subscriptions`);
    expect(typeof rows[0]?.["n"]).toBe("number");
  });

  it("invariant 6: the mirror stores only ids/plan/status/period — no card or raw-payload column exists", async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'billing_subscriptions'`,
      [schema],
    );
    const cols = rows.map((r) => String(r["column_name"]));
    expect(cols).toContain("status");
    expect(cols).toContain("stripe_subscription_id");
    for (const forbidden of ["card", "pan", "cvc", "number", "payload", "raw"]) {
      expect(cols.some((c) => c.includes(forbidden))).toBe(false);
    }
  });

  it("invariant 6: the billing_events ledger is append-only (UPDATE/DELETE rejected by the database)", async () => {
    await ingest(subEvent({ evtId: "evt_c5", subId: "sub_c5", userId: "uc5", status: "active" }));
    await expect(client.query(`UPDATE billing_events SET type = 'x' WHERE stripe_event_id = 'evt_c5'`)).rejects.toThrow();
    await expect(client.query(`DELETE FROM billing_events WHERE stripe_event_id = 'evt_c5'`)).rejects.toThrow();
  });

  it("invariant 3: in-process handlers fire EXACTLY once across a duplicate delivery", async () => {
    const b = makeBilling(db, adapter);
    const fired: string[] = [];
    b.onSubscriptionChange((e) => {
      fired.push(e.type);
    });
    const payload = subEvent({ evtId: "evt_h1", subId: "sub_h1", userId: "uh1", status: "active" });
    const now = 1_700_000_000;
    const sig = signStripe(payload, WEBHOOK_SECRET, now);
    const first = await b.ingestWebhook({ rawBody: new TextEncoder().encode(payload), signatureHeader: sig, nowEpochSeconds: now });
    const second = await b.ingestWebhook({ rawBody: new TextEncoder().encode(payload), signatureHeader: sig, nowEpochSeconds: now });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(fired).toEqual(["subscription.created"]);
  });

  it("the payment.failed event resolves the subscription by vendor id and fires payment.failed", async () => {
    await ingest(subEvent({ evtId: "evt_pf_seed", subId: "sub_pf", userId: "upf", status: "active" }));
    const b = makeBilling(db, adapter);
    const fired: { type: string; sub: { stripeSubscriptionId?: string } | null }[] = [];
    b.onSubscriptionChange((e) => {
      fired.push({ type: e.type, sub: (e as { subscription?: { stripeSubscriptionId?: string } | null }).subscription ?? null });
    });
    const inv = JSON.stringify({ id: "evt_pf1", type: "invoice.payment_failed", created: 1_700_000_100, data: { object: { subscription: "sub_pf" } } });
    const now = 1_700_000_100;
    await b.ingestWebhook({ rawBody: new TextEncoder().encode(inv), signatureHeader: signStripe(inv, WEBHOOK_SECRET, now), nowEpochSeconds: now });
    const pf = fired.find((e) => e.type === "payment.failed");
    expect(pf).toBeDefined();
    expect(pf?.sub?.stripeSubscriptionId).toBe("sub_pf");
  });

  it("an out-of-order OLDER event does not overwrite newer subscription state (event-timestamp guard)", async () => {
    const subId = "sub_oo";
    await ingest(subEvent({ evtId: "evt_oo_new", subId, userId: "uoo", status: "active", created: 2000 }));
    await ingest(subEvent({ evtId: "evt_oo_old", subId, userId: "uoo", status: "canceled", type: "customer.subscription.updated", created: 1000 }));
    const sub = await makeBilling(db, adapter).getSubscription("uoo");
    expect(sub?.status).toBe("active"); // newer state preserved
    expect(sub?.entitled).toBe(true);
  });

  it("an unknown/future Stripe status is stored without error and is not entitled (no poison webhook)", async () => {
    const r = await ingest(subEvent({ evtId: "evt_unk", subId: "sub_unk", userId: "uunk", status: "some_future_status" }));
    expect(r.applied).toBe(true);
    const sub = await makeBilling(db, adapter).getSubscription("uunk");
    expect(sub?.status).toBe("some_future_status");
    expect(sub?.entitled).toBe(false);
  });

  it("invariant 8: entitlement is true exactly for {active, trialing} across all statuses", async () => {
    const statuses = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"];
    for (let i = 0; i < statuses.length; i++) {
      const s = statuses[i];
      await ingest(subEvent({ evtId: `evt_ent_${i}`, subId: `sub_ent_${i}`, userId: `uent_${i}`, status: s, created: 1_700_000_000 + i }));
      const sub = await makeBilling(db, adapter).getSubscription(`uent_${i}`);
      expect(sub?.entitled).toBe(s === "active" || s === "trialing");
    }
  });

  it("invariant 4: the webhook route returns 200 and applies a verified event", async () => {
    const route = makeWebhookHandler(db, adapter);
    const payload = subEvent({ evtId: "evt_route200", subId: "sub_r200", userId: "ur200", status: "active" });
    const wnow = Math.floor(Date.now() / 1000);
    const req = new Request("http://x/api/webhooks/billing", {
      method: "POST",
      body: payload,
      headers: { "stripe-signature": signStripe(payload, WEBHOOK_SECRET, wnow) },
    });
    expect((await route(req)).status).toBe(200);
    const sub = await makeBilling(db, adapter).getSubscription("ur200");
    expect(sub?.stripeSubscriptionId).toBe("sub_r200");
  });
});

/* ─────────────────────── Block D — live Stripe test mode ─────────────────────── */

describe.skipIf(!hasStripe || !hasPg)("billing.subscription@1 · live Stripe test API", () => {
  let client: import("pg").Client;
  let db: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  let stripe: Stripe;
  const schema = `billing_live_${process.pid}`;
  const created: { customerId?: string; subscriptionId?: string } = {};

  beforeAll(async () => {
    process.env["BILLING_SECRET_KEY"] = STRIPE_KEY;
    process.env["BILLING_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
    __resetForTests();
    stripe = new Stripe(STRIPE_KEY as string, { apiVersion: "2026-05-27.dahlia" as Stripe.StripeConfig["apiVersion"] });
    const { Client } = await import("pg");
    client = new Client({ connectionString: PG_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const migration = await readFile(new URL("../migrations/001-create-billing-tables.sql", import.meta.url), "utf8");
    await client.query(migration);
    db = { query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows }) };
  }, 30_000);

  afterAll(async () => {
    try {
      if (created.subscriptionId) await stripe.subscriptions.cancel(created.subscriptionId);
      if (created.customerId) await stripe.customers.del(created.customerId);
    } catch {
      /* best-effort cleanup */
    }
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
    delete process.env["BILLING_SECRET_KEY"];
    delete process.env["BILLING_WEBHOOK_SECRET"];
    __resetForTests();
  });

  it("invariant 4: createCheckout returns a real hosted session url and writes no mirror row", async () => {
    const b = makeBilling(db, adapter);
    const session = await b.createCheckout({
      userId: "ud_checkout",
      planId: "pro",
      catalog: { get: () => ({ id: "pro", stripePriceId: TEST_PRICE_ID as string }), list: () => [] },
      successUrl: "https://example.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://example.test/billing",
    });
    expect(session.url).toMatch(/^https:\/\//);
    expect(await b.getSubscription("ud_checkout")).toBeNull();
  }, 30_000);

  it("invariant 4 + 8: a real subscription, mirrored from its (re-signed) event, is entitled with an item-level period end", async () => {
    const customer = await stripe.customers.create({ email: "billing-conf@example.test" });
    created.customerId = customer.id;
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: TEST_PRICE_ID as string }],
      metadata: { user_id: "ud_sub", plan_id: "pro" },
    });
    created.subscriptionId = sub.id;

    const payload = JSON.stringify({ id: `evt_live_${sub.id}`, type: "customer.subscription.created", data: { object: sub } });
    const now = Math.floor(Date.now() / 1000);
    const r = await makeBilling(db, adapter).ingestWebhook({
      rawBody: new TextEncoder().encode(payload),
      signatureHeader: signStripe(payload, WEBHOOK_SECRET, now),
      nowEpochSeconds: now,
    });
    expect(r.applied).toBe(true);

    const mirror = await makeBilling(db, adapter).getSubscription("ud_sub");
    expect(mirror?.stripeSubscriptionId).toBe(sub.id);
    expect(["active", "trialing"]).toContain(mirror?.status);
    expect(mirror?.entitled).toBe(true);
    expect(mirror?.currentPeriodEnd).not.toBeNull(); // proves item-level current_period_end mapping on REAL data
  }, 30_000);
});
