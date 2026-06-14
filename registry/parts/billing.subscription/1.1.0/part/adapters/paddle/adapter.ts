/**
 * Paddle (Billing) adapter for billing.subscription — the second vendor seam.
 *
 * ZERO-DEPENDENCY: the three write calls speak Paddle's REST API over the global
 * `fetch` (no @paddle SDK), and the inbound-webhook verifier is RAW node:crypto
 * HMAC over the raw request bytes (the webhooks.ingest mechanics). So both the
 * write path and verification are SDK- and network-free where it matters, and
 * conformance exercises them offline against a fake Paddle server + locally
 * signed payloads.
 *
 * Paddle specifics that shape this adapter (vs Stripe):
 *  - There is NO "create subscription checkout" call. You POST /transactions with
 *    the recurring price_id and redirect to data.checkout.url; Paddle creates the
 *    subscription only AFTER the customer pays, surfaced via the
 *    subscription.created/updated webhook — so the mirror stays webhook-derived
 *    (same invariant 4 as Stripe: createCheckout writes no row).
 *  - A transaction references a customer_id, not an email, so checkout first
 *    ensures a Customer (POST /customers; reuse the existing one on a 409).
 *  - Cancel-at-period-end is a SCHEDULED change (POST /subscriptions/{id}/cancel
 *    effective_from=next_billing_period); reactivate clears it (PATCH
 *    scheduled_change=null).
 *  - Signature header `Paddle-Signature: ts=..;h1=..` (h1 may repeat during
 *    secret rotation), signed bytes = `${ts}:${rawBody}`, key = the pdl_ntfset_
 *    secret used directly as UTF-8.
 *  - Success/cancel redirect URLs are configured on the Default Payment Link in
 *    the Paddle dashboard (the human provisioning step), not per checkout call —
 *    see seams.md. successUrl/cancelUrl are accepted for interface parity.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import process from "node:process";
import { redactSecrets, requireEnv } from "../../src/internal/config";
import { BillingError } from "../../src/internal/errors";
import type {
  BillingAdapter,
  CheckoutArgs,
  CheckoutSession,
  NeutralBillingEvent,
  ProrationBehavior,
  RemoteSubscription,
  SubscriptionStatus,
} from "../../src/internal/types";

const SIGNATURE_TOLERANCE_SECONDS = 300;
/** Absolute per-request deadline. Node's global fetch has NO default timeout,
 *  so a slow/hung endpoint (or a network-layer attacker) would block forever
 *  and pile up requests — bound it. The route maps the resulting vendor error
 *  to a 500 (retry-safe). */
const REQUEST_TIMEOUT_MS = 20_000;

/* ── Paddle wire shapes (permissive — decouples us from exact API drift) ── */

interface PaddleData {
  id?: string;
  status?: string;
  customer_id?: string;
  subscription_id?: string;
  current_billing_period?: { ends_at?: string } | null;
  scheduled_change?: { action?: string } | null;
  custom_data?: Record<string, unknown> | null;
  items?: Array<{ price?: { id?: string } }>;
  checkout?: { url?: string };
}
interface PaddleBody {
  data?: PaddleData | PaddleData[];
  error?: { code?: string; detail?: string };
}
interface PaddleEvent {
  event_id?: string;
  event_type?: string;
  occurred_at?: string;
  data?: PaddleData;
}

/** Resolve the Paddle API base URL: explicit override → key prefix → live. */
function baseUrl(apiKey: string): string {
  const override = process.env["PADDLE_BASE_URL"];
  if (override !== undefined && override !== "") return override.replace(/\/+$/, "");
  return apiKey.startsWith("pdl_sdbx_") ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
}

function vendorError(e: unknown): BillingError {
  return new BillingError("vendor", redactSecrets(e instanceof Error ? e.message : String(e)));
}

function singleData(body: PaddleBody): PaddleData {
  const d = body.data;
  if (d === undefined || Array.isArray(d)) return {};
  return d;
}

function isoToEpoch(iso: unknown): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function mapSubscription(sub: PaddleData): RemoteSubscription {
  const cd = sub.custom_data ?? {};
  const item = sub.items?.[0];
  return {
    vendorCustomerId: typeof sub.customer_id === "string" ? sub.customer_id : "",
    vendorSubscriptionId: typeof sub.id === "string" ? sub.id : "",
    vendorPriceId: typeof item?.price?.id === "string" ? item.price.id : "",
    status: (typeof sub.status === "string" ? sub.status : "") as SubscriptionStatus,
    currentPeriodEndEpoch: isoToEpoch(sub.current_billing_period?.ends_at),
    // A period-end cancel leaves status active with a scheduled cancel.
    cancelAtPeriodEnd: sub.scheduled_change?.action === "cancel",
    userId: typeof cd["user_id"] === "string" ? (cd["user_id"] as string) : null,
    planId: typeof cd["plan_id"] === "string" ? (cd["plan_id"] as string) : null,
  };
}

/** Map our neutral proration intent to Paddle's required proration_billing_mode. */
function prorationMode(p: ProrationBehavior): string {
  switch (p) {
    case "none":
      return "do_not_bill";
    case "always_invoice":
      return "full_immediately";
    case "create_prorations":
    default:
      return "prorated_immediately";
  }
}

/** One JSON request to Paddle. Network errors → BillingError('vendor'); the body
 *  is parsed but status is returned so callers decide (e.g. 409 customer reuse). */
async function paddleFetch(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; json: PaddleBody }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (idempotencyKey !== undefined) headers["Paddle-Idempotency-Key"] = idempotencyKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const init: RequestInit = { method, headers, signal: controller.signal };
  if (body !== undefined) init.body = JSON.stringify(body);
  try {
    const res = await fetch(`${baseUrl(apiKey)}${path}`, init);
    const text = await res.text(); // still under the deadline — a slow body can't hang us
    let json: PaddleBody = {};
    if (text !== "") {
      try {
        json = JSON.parse(text) as PaddleBody;
      } catch {
        json = {};
      }
    }
    return { status: res.status, json };
  } catch (e) {
    throw vendorError(e); // network error or AbortError (timeout) → redacted vendor error
  } finally {
    clearTimeout(timer);
  }
}

/** Throw a redacted BillingError('vendor') with Paddle's own code/detail on non-2xx. */
function ensureOk(r: { status: number; json: PaddleBody }, what: string): void {
  if (r.status >= 200 && r.status < 300) return;
  const code = r.json.error?.code ?? `http_${r.status}`;
  const detail = r.json.error?.detail ?? "";
  throw new BillingError("vendor", redactSecrets(`Paddle ${what} failed: ${code}${detail ? ` — ${detail}` : ""}`));
}

/** Ensure a Paddle Customer exists for this email, returning its ctm_ id.
 *  No idempotency key here: the 409-reuse path is the natural idempotency, and a
 *  shared key with the transaction call would alias two distinct operations. */
async function ensureCustomer(apiKey: string, email: string, userId: string): Promise<string> {
  const r = await paddleFetch("POST", "/customers", apiKey, {
    email,
    custom_data: { user_id: userId },
  });
  if (r.status >= 200 && r.status < 300) {
    const id = singleData(r.json).id;
    if (typeof id === "string" && id !== "") return id;
    throw new BillingError("vendor", "Paddle created a customer with no id");
  }
  // Email already in use → reuse the existing customer. The id is embedded in the
  // 409 detail string; fall back to a lookup by email if the shape ever changes.
  if (r.status === 409 && r.json.error?.code === "customer_already_exists") {
    const m = /ctm_[a-z0-9]+/i.exec(r.json.error?.detail ?? "");
    if (m !== null) return m[0];
    const look = await paddleFetch("GET", `/customers?email=${encodeURIComponent(email)}`, apiKey);
    const list = look.json.data;
    const first = Array.isArray(list) ? list[0] : undefined;
    if (first !== undefined && typeof first.id === "string" && first.id !== "") return first.id;
  }
  ensureOk(r, "create customer"); // throws (non-2xx, non-reusable)
  throw new BillingError("vendor", "Paddle customer resolution failed"); // unreachable
}

/** Test-only: parity with the stripe adapter's reset; the paddle adapter holds
 *  no memoized client (the API key is read per call), so this is a no-op. */
export function __resetForTests(): void {}

export const adapter: BillingAdapter = {
  name: "paddle",
  webhookSignatureHeader: "paddle-signature",

  async createCheckout(args: CheckoutArgs): Promise<CheckoutSession> {
    const apiKey = requireEnv("BILLING_SECRET_KEY");
    if (args.customerEmail === undefined || args.customerEmail === "") {
      throw new BillingError(
        "invalid_input",
        "the paddle adapter requires a customer email (pass userEmail) — Paddle binds a transaction to a customer_id, not an email (see seams.md)",
      );
    }
    try {
      const customerId = await ensureCustomer(apiKey, args.customerEmail, args.userId);
      const customData: Record<string, string> = { user_id: args.userId };
      if (args.planId !== undefined) customData["plan_id"] = args.planId;
      const r = await paddleFetch(
        "POST",
        "/transactions",
        apiKey,
        {
          items: [{ price_id: args.priceId, quantity: 1 }],
          customer_id: customerId,
          custom_data: customData,
          collection_mode: "automatic",
        },
        args.idempotencyKey,
      );
      ensureOk(r, "create transaction");
      const data = singleData(r.json);
      const url = data.checkout?.url;
      if (typeof url !== "string" || url === "") {
        throw new BillingError(
          "vendor",
          "Paddle returned a transaction with no checkout url — set a Default Payment Link in the seller dashboard (see seams.md)",
        );
      }
      return { id: typeof data.id === "string" ? data.id : "", url };
    } catch (e) {
      throw e instanceof BillingError ? e : vendorError(e);
    }
  },

  async setCancelAtPeriodEnd(
    vendorSubscriptionId: string,
    cancel: boolean,
    idempotencyKey?: string,
  ): Promise<RemoteSubscription> {
    const apiKey = requireEnv("BILLING_SECRET_KEY");
    const id = encodeURIComponent(vendorSubscriptionId);
    const r = cancel
      ? await paddleFetch("POST", `/subscriptions/${id}/cancel`, apiKey, { effective_from: "next_billing_period" }, idempotencyKey)
      : await paddleFetch("PATCH", `/subscriptions/${id}`, apiKey, { scheduled_change: null }, idempotencyKey);
    ensureOk(r, cancel ? "cancel subscription" : "reactivate subscription");
    return mapSubscription(singleData(r.json));
  },

  async changePlan(
    vendorSubscriptionId: string,
    newPriceId: string,
    proration: ProrationBehavior,
    idempotencyKey?: string,
  ): Promise<RemoteSubscription> {
    const apiKey = requireEnv("BILLING_SECRET_KEY");
    // Paddle items[] is a FULL replacement: send exactly the one desired price.
    const r = await paddleFetch(
      "PATCH",
      `/subscriptions/${encodeURIComponent(vendorSubscriptionId)}`,
      apiKey,
      { items: [{ price_id: newPriceId, quantity: 1 }], proration_billing_mode: prorationMode(proration) },
      idempotencyKey,
    );
    ensureOk(r, "change plan");
    return mapSubscription(singleData(r.json));
  },

  verifyAndParseWebhook(
    rawBody: Uint8Array,
    signatureHeader: string,
    nowEpochSeconds: number,
  ): NeutralBillingEvent {
    const secret = requireEnv("BILLING_WEBHOOK_SECRET");

    let ts: string | null = null;
    const h1s: string[] = [];
    for (const el of signatureHeader.split(";")) {
      const i = el.indexOf("=");
      if (i === -1) continue;
      const k = el.slice(0, i).trim();
      const v = el.slice(i + 1).trim();
      if (k === "ts") ts = v;
      else if (k === "h1") h1s.push(v); // multiple during secret rotation
    }
    if (ts === null) throw new BillingError("invalid_signature", "Paddle-Signature carries no ts= element");
    if (h1s.length === 0) throw new BillingError("invalid_signature", "Paddle-Signature carries no h1= element");

    const body = Buffer.from(rawBody);
    const expected = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${ts}:`, "utf8"), body]))
      .digest();
    const ok = h1s.some((v) => {
      const cand = Buffer.from(v, "hex");
      return cand.length === expected.length && timingSafeEqual(cand, expected);
    });
    if (!ok) {
      throw new BillingError("invalid_signature", "signature did not verify over the raw payload bytes");
    }

    // Window check AFTER signature → an out-of-window result is authentic-but-stale.
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(nowEpochSeconds - tsNum) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new BillingError(
        "timestamp_out_of_window",
        `signed timestamp outside the ±${SIGNATURE_TOLERANCE_SECONDS}s window`,
      );
    }

    let evt: PaddleEvent;
    try {
      evt = JSON.parse(body.toString("utf8")) as PaddleEvent;
    } catch {
      throw new BillingError("invalid_signature", "payload is not valid JSON after verification");
    }
    // occurred_at (ISO) orders the mirror upsert (out-of-order guard); fall back
    // to the verified header ts, which is within ±300s of emission.
    const createdEpoch = isoToEpoch(evt.occurred_at) ?? tsNum;
    return mapEvent(evt, createdEpoch);
  },
};

function mapEvent(evt: PaddleEvent, createdEpoch: number): NeutralBillingEvent {
  const id = typeof evt.event_id === "string" ? evt.event_id : "";
  const rawType = typeof evt.event_type === "string" ? evt.event_type : "";
  const data = evt.data ?? {};

  switch (rawType) {
    case "subscription.created":
      return { id, rawType, createdEpoch, action: { kind: "subscription.created", subscription: mapSubscription(data) } };
    // activated = trial→active or paused→active; treat as an update of mirror state.
    case "subscription.activated":
    case "subscription.updated":
      return { id, rawType, createdEpoch, action: { kind: "subscription.updated", subscription: mapSubscription(data) } };
    case "subscription.canceled":
      return {
        id,
        rawType,
        createdEpoch,
        action: { kind: "subscription.canceled", subscription: { ...mapSubscription(data), status: "canceled" } },
      };
    case "transaction.payment_failed": {
      const subId = typeof data.subscription_id === "string" ? data.subscription_id : null;
      return { id, rawType, createdEpoch, action: { kind: "payment.failed", userId: null, vendorSubscriptionId: subId } };
    }
    default:
      return { id, rawType, createdEpoch, action: { kind: "ignored" } };
  }
}
