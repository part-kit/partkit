/**
 * Conformance suite for capability billing.subscription@1.
 *
 * The SAME suite runs against EVERY adapter (docs/02 §4): the publish script
 * materializes each adapter into adapters/selected/ and runs this file once per
 * adapter, branching on adapter.name via VENDORS. Blocks, gated by env:
 *  A — DB-free (always): validation, typed+redacted errors, write boundary,
 *      own-tables-only SQL. RecordingExecutor + a vendor-neutral FakeAdapter.
 *  B — offline signature (always): the REAL selected adapter's HMAC verifier,
 *      exercised with locally-signed payloads (no network, no vendor key),
 *      cross-checked against an independent oracle (the vendor's own signer, or a
 *      pinned known-answer vector when the vendor publishes no signer).
 *  C — idempotency / state (real Postgres, PARTKIT_TEST_DATABASE_URL): the
 *      shipped migration + webhook-derived mirror, idempotent under replay.
 *  W — offline writes (paddle only, always): the real paddle adapter's REST
 *      write calls (customer + transaction + cancel/reactivate/change-plan)
 *      against a protocol-faithful fake Paddle server — no live creds needed.
 *  D — live Stripe test mode (stripe only; STRIPE_TEST_SECRET_KEY + PG): a real
 *      checkout + a real subscription mirrored from a (re-signed) event.
 *
 * No vendor SDK is imported at module scope: the stripe oracle + live block
 * dynamic-import "stripe" so the paddle isolation (which does not install it)
 * still loads this file. Each test names the contract invariant it makes true
 * (contract.json ↔ this file stay 1:1).
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { signStripe, signPaddle } from "./fake-sender";

const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];
const STRIPE_KEY = process.env["STRIPE_TEST_SECRET_KEY"];
const TEST_PRICE_ID = process.env["STRIPE_TEST_PRICE_ID"];
const hasPg = PG_URL !== undefined && PG_URL !== "";
const hasStripe = STRIPE_KEY !== undefined && STRIPE_KEY !== "" && TEST_PRICE_ID !== undefined && TEST_PRICE_ID !== "";

const iso = (epoch: number): string => new Date(epoch * 1000).toISOString();

/* ─────────────────────────── vendor profiles ─────────────────────────── */

interface SubEventOpts {
  evtId: string;
  kind?: "created" | "updated" | "canceled";
  subId?: string;
  userId?: string | null;
  planId?: string | null;
  status?: string;
  priceId?: string;
  periodEndEpoch?: number;
  cancelAtPeriodEnd?: boolean;
  createdEpoch?: number;
}

interface VendorProfile {
  /** A webhook secret in the vendor's own format. */
  webhookSecret: string;
  /** Request header the route reads (must equal adapter.webhookSignatureHeader). */
  headerName: string;
  /** Sign a payload into the vendor's signature header. decoy adds a second,
   *  non-matching signature element (key-rotation tolerance). */
  sign(payload: string, secret: string, now: number, decoy?: boolean): string;
  /** A subscription.{created,updated,canceled} event JSON in the vendor's shape. */
  subEvent(o: SubEventOpts): string;
  /** A payment-failed event referencing a subscription id, vendor-shaped. */
  paymentFailedEvent(o: { evtId: string; subId: string; createdEpoch?: number }): string;
  /** Syntactically-valid headers that MUST be rejected as a typed error. */
  badHeaders(now: number): string[];
  /** A syntactically-valid header with the wrong digest → route 400. */
  badSignature: string;
  /** Independent oracle: re-sign via the vendor's own code (Stripe SDK). */
  oracle?: (payload: string, secret: string, now: number) => Promise<string>;
  /** Pinned known-answer vector, when the vendor publishes no signer. */
  knownAnswer?: { header: string; body: string; secret: string; now: number; evtId: string };
}

const STRIPE_PROFILE: VendorProfile = {
  webhookSecret: "whsec_conformance_test_secret_value",
  headerName: "stripe-signature",
  sign: (payload, secret, now, decoy) => signStripe(payload, secret, now, decoy),
  subEvent: (o) => {
    const metadata: Record<string, string> = {};
    if (o.userId !== null && o.userId !== undefined) metadata["user_id"] = o.userId;
    if (o.planId !== null && o.planId !== undefined) metadata["plan_id"] = o.planId;
    const type =
      o.kind === "canceled"
        ? "customer.subscription.deleted"
        : o.kind === "updated"
          ? "customer.subscription.updated"
          : "customer.subscription.created";
    return JSON.stringify({
      id: o.evtId,
      type,
      created: o.createdEpoch ?? 1_700_000_000,
      data: {
        object: {
          id: o.subId ?? "sub_1",
          status: o.status ?? "active",
          customer: "cus_1",
          cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
          metadata,
          items: { data: [{ id: "si_1", current_period_end: o.periodEndEpoch ?? 1_900_000_000, price: { id: o.priceId ?? "price_pro_test" } }] },
        },
      },
    });
  },
  paymentFailedEvent: (o) =>
    JSON.stringify({
      id: o.evtId,
      type: "invoice.payment_failed",
      created: o.createdEpoch ?? 1_700_000_100,
      data: { object: { subscription: o.subId } },
    }),
  badHeaders: (now) => ["", `t=${now}`, "v1=abc"],
  badSignature: "t=1,v1=deadbeef",
  oracle: async (payload, secret, now) => {
    const Stripe = (await import("stripe")).default;
    return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: now });
  },
};

const PADDLE_PROFILE: VendorProfile = {
  webhookSecret: "pdl_ntfset_conformance_test_secret",
  headerName: "paddle-signature",
  sign: (payload, secret, now, decoy) => signPaddle(payload, secret, now, decoy),
  subEvent: (o) => {
    const customData: Record<string, string> = {};
    if (o.userId !== null && o.userId !== undefined) customData["user_id"] = o.userId;
    if (o.planId !== null && o.planId !== undefined) customData["plan_id"] = o.planId;
    const eventType =
      o.kind === "canceled" ? "subscription.canceled" : o.kind === "updated" ? "subscription.updated" : "subscription.created";
    return JSON.stringify({
      event_id: o.evtId,
      event_type: eventType,
      occurred_at: iso(o.createdEpoch ?? 1_700_000_000),
      data: {
        id: o.subId ?? "sub_1",
        status: o.status ?? "active",
        customer_id: "ctm_1",
        custom_data: customData,
        items: [{ price: { id: o.priceId ?? "price_pro_test" } }],
        current_billing_period: { ends_at: iso(o.periodEndEpoch ?? 1_900_000_000) },
        scheduled_change: (o.cancelAtPeriodEnd ?? false) ? { action: "cancel", effective_at: iso(o.periodEndEpoch ?? 1_900_000_000) } : null,
      },
    });
  },
  paymentFailedEvent: (o) =>
    JSON.stringify({
      event_id: o.evtId,
      event_type: "transaction.payment_failed",
      occurred_at: iso(o.createdEpoch ?? 1_700_000_100),
      data: { id: "txn_1", status: "past_due", customer_id: "ctm_1", subscription_id: o.subId },
    }),
  badHeaders: (now) => ["", `ts=${now}`, "h1=abc", `ts=${now};h1=`, `ts=${now},h1=deadbeef`],
  badSignature: "ts=1;h1=deadbeef",
  knownAnswer: {
    now: 1671552777,
    secret: "pdl_ntfset_knownanswer_secret",
    body: '{"event_id":"evt_kat_01","event_type":"subscription.created"}',
    header: "ts=1671552777;h1=7159ea797130c4282e1c85ffc423e891c04ff60fed907f8d3b3b13a3c9a27c17",
    evtId: "evt_kat_01",
  },
};

const PROFILES: Record<string, VendorProfile> = { stripe: STRIPE_PROFILE, paddle: PADDLE_PROFILE };
const selectedProfile = PROFILES[adapter.name];
if (selectedProfile === undefined) {
  throw new Error(`No conformance profile for adapter "${adapter.name}" — add one to PROFILES.`);
}
const vendor: VendorProfile = selectedProfile;

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
  readonly webhookSignatureHeader = "fake-signature";
  readonly calls: string[] = [];
  nextEvent: NeutralBillingEvent | null = null;
  failCheckout: Error | null = null;

  async createCheckout(_args: CheckoutArgs): Promise<CheckoutSession> {
    this.calls.push("createCheckout");
    if (this.failCheckout !== null) throw this.failCheckout;
    return { id: "cs_fake", url: "https://vendor.test/checkout/cs_fake" };
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

/* ─────────────────────────────── Block A — DB-free ─────────────────────────────── */

describe("billing.subscription@1 · DB-free (no database, no vendor)", () => {
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
      rawType: "subscription.created",
      createdEpoch: 1,
      action: { kind: "subscription.created", subscription: { ...CANNED_REMOTE, userId: "u'; DROP TABLE billing_subscriptions; --" } },
    };
    const b = makeBilling(rec, fake);
    await b.ingestWebhook({ rawBody: new Uint8Array(), signatureHeader: "sig", nowEpochSeconds: 1 });
    expect(rec.calls.length).toBeGreaterThan(0);
    for (const c of rec.calls) {
      expect(c.sql).toMatch(/billing_(subscriptions|events)/);
      expect(c.sql).not.toMatch(/\b(auth_|users|drop\s+table)\b/i);
    }
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

    expect(rec.calls.some((c) => /\b(insert|update)\b/i.test(c.sql))).toBe(false);
  });
});

/* ───────────────────────── Block B — offline signature ───────────────────────── */

describe(`billing.subscription@1 · webhook signature (offline, real ${adapter.name} verifier)`, () => {
  beforeAll(() => {
    process.env["BILLING_WEBHOOK_SECRET"] = vendor.webhookSecret;
  });
  afterAll(() => {
    delete process.env["BILLING_WEBHOOK_SECRET"];
  });

  const now = 1_700_000_000;
  const payload = vendor.subEvent({ evtId: "evt_b", userId: "u1" });
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  it("invariant 5: a correctly-signed payload verifies and parses to the event", () => {
    const header = vendor.sign(payload, vendor.webhookSecret, now);
    const event = adapter.verifyAndParseWebhook(enc(payload), header, now);
    expect(event.id).toBe("evt_b");
    expect(event.action.kind).toBe("subscription.created");
  });

  it("invariant 5: a decoy signature alongside the real one still verifies (key rotation)", () => {
    const header = vendor.sign(payload, vendor.webhookSecret, now, true);
    expect(() => adapter.verifyAndParseWebhook(enc(payload), header, now)).not.toThrow();
  });

  it("invariant 5: tampered body, wrong secret, and missing elements are rejected as invalid_signature", () => {
    const good = vendor.sign(payload, vendor.webhookSecret, now);
    const tampered = `${payload} `;
    expect(() => adapter.verifyAndParseWebhook(enc(tampered), good, now)).toThrowError(/signature/i);
    const wrong = vendor.sign(payload, "totally_wrong_secret", now);
    expect(() => adapter.verifyAndParseWebhook(enc(payload), wrong, now)).toThrowError(/signature/i);
    for (const h of vendor.badHeaders(now)) {
      expect(() => adapter.verifyAndParseWebhook(enc(payload), h, now)).toThrow(BillingError);
    }
  });

  it("invariant 5: a signed timestamp outside the ±300s window is rejected as timestamp_out_of_window", () => {
    const header = vendor.sign(payload, vendor.webhookSecret, now);
    const err = (() => {
      try {
        adapter.verifyAndParseWebhook(enc(payload), header, now + 10 * 60);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BillingError);
    expect((err as BillingError).code).toBe("timestamp_out_of_window");
  });

  (vendor.oracle ? it : it.skip)("invariant 5: our raw verifier agrees with the vendor's own signer (wire-format oracle)", async () => {
    const header = await vendor.oracle!(payload, vendor.webhookSecret, now);
    expect(() => adapter.verifyAndParseWebhook(enc(payload), header, now)).not.toThrow();
  });

  (vendor.knownAnswer ? it : it.skip)("invariant 5: the verifier accepts a pinned known-answer vector (wire-format anchor)", () => {
    const ka = vendor.knownAnswer!;
    process.env["BILLING_WEBHOOK_SECRET"] = ka.secret;
    try {
      const event = adapter.verifyAndParseWebhook(enc(ka.body), ka.header, ka.now);
      expect(event.id).toBe(ka.evtId);
    } finally {
      process.env["BILLING_WEBHOOK_SECRET"] = vendor.webhookSecret;
    }
  });

  it("invariant 5: the webhook route maps to the vendor retry contract — 400 on bad signature, 500 on storage failure", async () => {
    const rec = new RecordingExecutor();
    const route = makeWebhookHandler(rec, adapter);
    const bad = new Request("http://x/api/webhooks/billing", {
      method: "POST",
      body: payload,
      headers: { [vendor.headerName]: vendor.badSignature },
    });
    expect((await route(bad)).status).toBe(400);
    expect(rec.calls.length).toBe(0);
    // valid signature but storage fails → 500. Sign with the current time so the
    // ±300s window passes against the route's wall clock.
    const wnow = Math.floor(Date.now() / 1000);
    const freshPayload = vendor.subEvent({ evtId: "evt_route500", userId: "u1", status: "active" });
    rec.failWith = new Error("db unavailable");
    const good = new Request("http://x/api/webhooks/billing", {
      method: "POST",
      body: freshPayload,
      headers: { [vendor.headerName]: vendor.sign(freshPayload, vendor.webhookSecret, wnow) },
    });
    expect((await route(good)).status).toBe(500);
  });
});

/* ───────────────────── Block C — idempotency / state (real PG) ───────────────────── */

describe.skipIf(!hasPg)(`billing.subscription@1 · idempotency + state (real Postgres, ${adapter.name})`, () => {
  let client: import("pg").Client;
  let db: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  const schema = `billing_conf_${process.pid}`;

  beforeAll(async () => {
    process.env["BILLING_WEBHOOK_SECRET"] = vendor.webhookSecret;
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
      signatureHeader: vendor.sign(payload, vendor.webhookSecret, now),
      nowEpochSeconds: now,
    });
  }

  it("invariant 4 (b) + 8: a verified subscription.created upserts the mirror and entitlement is true for active", async () => {
    const r = await ingest(vendor.subEvent({ evtId: "evt_c1", subId: "sub_c1", userId: "uc1", planId: "pro", status: "active" }));
    expect(r.applied).toBe(true);
    const sub = await makeBilling(db, adapter).getSubscription("uc1");
    expect(sub?.stripeSubscriptionId).toBe("sub_c1");
    expect(sub?.planId).toBe("pro");
    expect(sub?.entitled).toBe(true);
  });

  it("invariant 3: a redelivered event id records and applies at most once", async () => {
    const payload = vendor.subEvent({ evtId: "evt_c2", subId: "sub_c2", userId: "uc2", status: "active" });
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
    await ingest(vendor.subEvent({ evtId: "evt_c3a", subId: "sub_c3", userId: "uc3", status: "active" }));
    await ingest(vendor.subEvent({ evtId: "evt_c3b", subId: "sub_c3", userId: "uc3", status: "canceled", kind: "updated" }));
    const sub = await makeBilling(db, adapter).getSubscription("uc3");
    expect(sub?.status).toBe("canceled");
    expect(sub?.entitled).toBe(false);
  });

  it("invariant 7: SQL metacharacters in a user id round-trip literally and never execute (injection)", async () => {
    const evil = "uc4'; DROP TABLE billing_subscriptions; --";
    await ingest(vendor.subEvent({ evtId: "evt_c4", subId: "sub_c4", userId: evil, status: "active" }));
    const sub = await makeBilling(db, adapter).getSubscription(evil);
    expect(sub?.userId).toBe(evil);
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
    await ingest(vendor.subEvent({ evtId: "evt_c5", subId: "sub_c5", userId: "uc5", status: "active" }));
    await expect(client.query(`UPDATE billing_events SET type = 'x' WHERE stripe_event_id = 'evt_c5'`)).rejects.toThrow();
    await expect(client.query(`DELETE FROM billing_events WHERE stripe_event_id = 'evt_c5'`)).rejects.toThrow();
  });

  it("invariant 3: in-process handlers fire EXACTLY once across a duplicate delivery", async () => {
    const b = makeBilling(db, adapter);
    const fired: string[] = [];
    b.onSubscriptionChange((e) => {
      fired.push(e.type);
    });
    const payload = vendor.subEvent({ evtId: "evt_h1", subId: "sub_h1", userId: "uh1", status: "active" });
    const now = 1_700_000_000;
    const sig = vendor.sign(payload, vendor.webhookSecret, now);
    const first = await b.ingestWebhook({ rawBody: new TextEncoder().encode(payload), signatureHeader: sig, nowEpochSeconds: now });
    const second = await b.ingestWebhook({ rawBody: new TextEncoder().encode(payload), signatureHeader: sig, nowEpochSeconds: now });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(fired).toEqual(["subscription.created"]);
  });

  it("the payment.failed event resolves the subscription by vendor id and fires payment.failed", async () => {
    await ingest(vendor.subEvent({ evtId: "evt_pf_seed", subId: "sub_pf", userId: "upf", status: "active" }));
    const b = makeBilling(db, adapter);
    const fired: { type: string; sub: { stripeSubscriptionId?: string } | null }[] = [];
    b.onSubscriptionChange((e) => {
      fired.push({ type: e.type, sub: (e as { subscription?: { stripeSubscriptionId?: string } | null }).subscription ?? null });
    });
    const inv = vendor.paymentFailedEvent({ evtId: "evt_pf1", subId: "sub_pf", createdEpoch: 1_700_000_100 });
    const now = 1_700_000_100;
    await b.ingestWebhook({ rawBody: new TextEncoder().encode(inv), signatureHeader: vendor.sign(inv, vendor.webhookSecret, now), nowEpochSeconds: now });
    const pf = fired.find((e) => e.type === "payment.failed");
    expect(pf).toBeDefined();
    expect(pf?.sub?.stripeSubscriptionId).toBe("sub_pf");
  });

  it("an out-of-order OLDER event does not overwrite newer subscription state (event-timestamp guard)", async () => {
    const subId = "sub_oo";
    await ingest(vendor.subEvent({ evtId: "evt_oo_new", subId, userId: "uoo", status: "active", createdEpoch: 1_700_002_000 }));
    await ingest(vendor.subEvent({ evtId: "evt_oo_old", subId, userId: "uoo", status: "canceled", kind: "updated", createdEpoch: 1_700_001_000 }));
    const sub = await makeBilling(db, adapter).getSubscription("uoo");
    expect(sub?.status).toBe("active"); // newer state preserved
    expect(sub?.entitled).toBe(true);
  });

  it("an unknown/future status is stored without error and is not entitled (no poison webhook)", async () => {
    const r = await ingest(vendor.subEvent({ evtId: "evt_unk", subId: "sub_unk", userId: "uunk", status: "some_future_status" }));
    expect(r.applied).toBe(true);
    const sub = await makeBilling(db, adapter).getSubscription("uunk");
    expect(sub?.status).toBe("some_future_status");
    expect(sub?.entitled).toBe(false);
  });

  it("invariant 8: entitlement is true exactly for {active, trialing} across all statuses", async () => {
    const statuses = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"];
    for (let i = 0; i < statuses.length; i++) {
      const s = statuses[i];
      await ingest(vendor.subEvent({ evtId: `evt_ent_${i}`, subId: `sub_ent_${i}`, userId: `uent_${i}`, status: s, createdEpoch: 1_700_000_000 + i }));
      const sub = await makeBilling(db, adapter).getSubscription(`uent_${i}`);
      expect(sub?.entitled).toBe(s === "active" || s === "trialing");
    }
  });

  it("a verified event with no subscription id is recorded but mints no mirror row (no empty-PK collision)", async () => {
    const r = await ingest(vendor.subEvent({ evtId: "evt_noid", subId: "", userId: "unoid", status: "active" }));
    expect(r.applied).toBe(true); // the event is recorded in the ledger...
    expect(await makeBilling(db, adapter).getSubscription("unoid")).toBeNull(); // ...but no mirror row was written
  });

  it("invariant 4: the webhook route returns 200 and applies a verified event", async () => {
    const route = makeWebhookHandler(db, adapter);
    const payload = vendor.subEvent({ evtId: "evt_route200", subId: "sub_r200", userId: "ur200", status: "active" });
    const wnow = Math.floor(Date.now() / 1000);
    const req = new Request("http://x/api/webhooks/billing", {
      method: "POST",
      body: payload,
      headers: { [vendor.headerName]: vendor.sign(payload, vendor.webhookSecret, wnow) },
    });
    expect((await route(req)).status).toBe(200);
    const sub = await makeBilling(db, adapter).getSubscription("ur200");
    expect(sub?.stripeSubscriptionId).toBe("sub_r200");
  });
});

/* ─────────────── Block W — offline writes (paddle only, fake Paddle server) ─────────────── */

interface RecordedReq {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  auth: string | undefined;
  idem: string | undefined;
}

class FakePaddle {
  private server: Server | null = null;
  readonly reqs: RecordedReq[] = [];
  baseUrl = "";
  customerStatus = 201;
  customerBody: unknown = { data: { id: "ctm_new" } };
  txnStatus = 201;
  txnBody: unknown = { data: { id: "txn_1", checkout: { url: "https://sandbox-checkout.paddle.com/?_ptxn=txn_1" } } };

  private sub(scheduled: boolean): unknown {
    return {
      data: {
        id: "sub_w1",
        status: "active",
        customer_id: "ctm_new",
        custom_data: { user_id: "u1", plan_id: "pro" },
        items: [{ price: { id: "pri_pro" } }],
        current_billing_period: { ends_at: iso(1_900_000_000) },
        scheduled_change: scheduled ? { action: "cancel", effective_at: iso(1_900_000_000) } : null,
      },
    };
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: Record<string, unknown> | undefined;
        try {
          body = raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>);
        } catch {
          body = undefined;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        this.reqs.push({
          method: req.method ?? "",
          path: url.pathname,
          body,
          auth: req.headers["authorization"],
          idem: req.headers["paddle-idempotency-key"] as string | undefined,
        });
        const [status, payload] = this.route(req.method ?? "", url.pathname);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server!.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  private route(method: string, path: string): [number, unknown] {
    if (method === "POST" && path === "/customers") return [this.customerStatus, this.customerBody];
    if (method === "GET" && path === "/customers") return [200, { data: [{ id: "ctm_lookup" }] }];
    if (method === "POST" && path === "/transactions") return [this.txnStatus, this.txnBody];
    if (method === "POST" && /^\/subscriptions\/[^/]+\/cancel$/.test(path)) return [200, this.sub(true)];
    if (method === "PATCH" && /^\/subscriptions\/[^/]+$/.test(path)) return [200, this.sub(false)];
    return [404, { error: { code: "not_found", detail: "no route" } }];
  }

  reset(): void {
    this.reqs.length = 0;
    this.customerStatus = 201;
    this.customerBody = { data: { id: "ctm_new" } };
    this.txnStatus = 201;
    this.txnBody = { data: { id: "txn_1", checkout: { url: "https://sandbox-checkout.paddle.com/?_ptxn=txn_1" } } };
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

describe.skipIf(adapter.name !== "paddle")("billing.subscription@1 · paddle writes (offline, fake Paddle API)", () => {
  const fake = new FakePaddle();
  const APIKEY = "pdl_sdbx_apikey_topsecretpaddlevalue";

  beforeAll(async () => {
    const base = await fake.start();
    process.env["PADDLE_BASE_URL"] = base;
    process.env["BILLING_SECRET_KEY"] = APIKEY;
  });
  afterAll(async () => {
    await fake.stop();
    delete process.env["PADDLE_BASE_URL"];
    delete process.env["BILLING_SECRET_KEY"];
  });
  beforeEach(() => fake.reset());

  it("createCheckout ensures a customer, creates a transaction, and returns the hosted checkout url", async () => {
    const session = await adapter.createCheckout({
      userId: "u1",
      priceId: "pri_pro",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
      customerEmail: "buyer@example.test",
      planId: "pro",
    });
    expect(session.url).toContain("_ptxn=txn_1");
    const cust = fake.reqs.find((r) => r.method === "POST" && r.path === "/customers");
    expect(cust?.body?.["email"]).toBe("buyer@example.test");
    expect(cust?.auth).toBe(`Bearer ${APIKEY}`);
    const txn = fake.reqs.find((r) => r.method === "POST" && r.path === "/transactions");
    const items = txn?.body?.["items"] as Array<{ price_id?: string }> | undefined;
    expect(items?.[0]?.price_id).toBe("pri_pro");
    expect(txn?.body?.["customer_id"]).toBe("ctm_new");
    expect(txn?.body?.["custom_data"]).toMatchObject({ user_id: "u1", plan_id: "pro" });
  });

  it("createCheckout without an email fails fast with invalid_input and never calls Paddle", async () => {
    await expect(
      adapter.createCheckout({ userId: "u1", priceId: "pri_pro", successUrl: "s", cancelUrl: "c" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.reqs.length).toBe(0);
  });

  it("createCheckout reuses the existing customer on a 409 (id parsed from the error detail)", async () => {
    fake.customerStatus = 409;
    fake.customerBody = { error: { code: "customer_already_exists", detail: "customer email conflicts with customer of id ctm_existing42" } };
    await adapter.createCheckout({
      userId: "u1", priceId: "pri_pro", successUrl: "s", cancelUrl: "c", customerEmail: "dupe@example.test", planId: "pro",
    });
    const txn = fake.reqs.find((r) => r.path === "/transactions");
    expect(txn?.body?.["customer_id"]).toBe("ctm_existing42");
  });

  it("setCancelAtPeriodEnd(true) schedules a period-end cancel and reports cancelAtPeriodEnd", async () => {
    const remote = await adapter.setCancelAtPeriodEnd("sub_w1", true, "idem-1");
    expect(remote.cancelAtPeriodEnd).toBe(true);
    const call = fake.reqs.find((r) => r.method === "POST" && r.path === "/subscriptions/sub_w1/cancel");
    expect(call?.body?.["effective_from"]).toBe("next_billing_period");
    expect(call?.idem).toBe("idem-1");
  });

  it("reactivate (cancel=false) clears the scheduled change via PATCH", async () => {
    const remote = await adapter.setCancelAtPeriodEnd("sub_w1", false);
    expect(remote.cancelAtPeriodEnd).toBe(false);
    const call = fake.reqs.find((r) => r.method === "PATCH" && r.path === "/subscriptions/sub_w1");
    expect(call?.body).toMatchObject({ scheduled_change: null });
  });

  it("changePlan replaces items and maps proration intent to Paddle's mode", async () => {
    await adapter.changePlan("sub_w1", "pri_enterprise", "always_invoice");
    const call = fake.reqs.find((r) => r.method === "PATCH" && r.path === "/subscriptions/sub_w1");
    const items = call?.body?.["items"] as Array<{ price_id?: string }> | undefined;
    expect(items?.[0]?.price_id).toBe("pri_enterprise");
    expect(call?.body?.["proration_billing_mode"]).toBe("full_immediately");
  });

  it("a vendor error surfaces as BillingError('vendor') with the api key redacted", async () => {
    fake.txnStatus = 500;
    fake.txnBody = { error: { code: "internal_error", detail: `boom for ${APIKEY}` } };
    const err = await adapter
      .createCheckout({ userId: "u1", priceId: "pri_pro", successUrl: "s", cancelUrl: "c", customerEmail: "x@example.test" })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BillingError);
    expect((err as BillingError).code).toBe("vendor");
    expect((err as Error).message).not.toContain(APIKEY);
    expect((err as Error).message).toContain("[redacted]");
  });
});

/* ─────────────────────── Block D — live Stripe test mode (stripe only) ─────────────────────── */

describe.skipIf(adapter.name !== "stripe" || !hasStripe || !hasPg)("billing.subscription@1 · live Stripe test API", () => {
  let client: import("pg").Client;
  let db: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  let stripe: import("stripe").default;
  const schema = `billing_live_${process.pid}`;
  const created: { customerId?: string; subscriptionId?: string } = {};

  beforeAll(async () => {
    process.env["BILLING_SECRET_KEY"] = STRIPE_KEY;
    process.env["BILLING_WEBHOOK_SECRET"] = STRIPE_PROFILE.webhookSecret;
    __resetForTests();
    const Stripe = (await import("stripe")).default;
    stripe = new Stripe(STRIPE_KEY as string, { apiVersion: "2026-05-27.dahlia" as import("stripe").default.StripeConfig["apiVersion"] });
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
      signatureHeader: signStripe(payload, STRIPE_PROFILE.webhookSecret, now),
      nowEpochSeconds: now,
    });
    expect(r.applied).toBe(true);

    const mirror = await makeBilling(db, adapter).getSubscription("ud_sub");
    expect(mirror?.stripeSubscriptionId).toBe(sub.id);
    expect(["active", "trialing"]).toContain(mirror?.status);
    expect(mirror?.entitled).toBe(true);
    expect(mirror?.currentPeriodEnd).not.toBeNull();
  }, 30_000);
});
