/**
 * Stripe adapter for billing.subscription — the vendor seam.
 *
 * Holds all Stripe specifics: the lazily-built, memoized SDK client (write
 * calls only), and the inbound-webhook verifier. Verification is RAW
 * node:crypto HMAC over the raw request bytes (the webhooks.ingest mechanics),
 * NOT stripe.webhooks.constructEvent — so verification is SDK- and
 * network-free and the conformance suite can exercise it offline. The Stripe
 * SDK is a runtime dependency (declared in the contract adapter's
 * npm_dependencies) for the API calls, not for verification.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { loadConfig, redactSecrets, requireEnv } from "../../src/internal/config";
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

const API_VERSION = "2026-05-27.dahlia";
const SIGNATURE_TOLERANCE_SECONDS = 300;

let client: Stripe | null = null;
function getStripe(): Stripe {
  if (client !== null) return client;
  const cfg = loadConfig(); // throws BillingError('config') if env missing
  client = new Stripe(cfg.secretKey, {
    apiVersion: API_VERSION, // the literal stripe@22 pins (LatestApiVersion)
    appInfo: { name: "partkit/billing.subscription", version: "1.0.0" },
    maxNetworkRetries: 2, // bounded retries with the SDK's exponential backoff
  });
  return client;
}

/** Test-only: drop the memoized client so env changes re-evaluate. */
export function __resetForTests(): void {
  client = null;
}

/** Minimal read shape — decouples our mapper from Stripe's exact .d.ts (which
 *  skipLibCheck does not type) and from cross-version field drift. */
interface SubShape {
  id: string;
  status: string;
  customer: string | { id: string } | null;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string> | null;
  items?: { data?: Array<{ id?: string; current_period_end?: number; price?: { id?: string } }> };
}

function customerId(c: SubShape["customer"]): string {
  if (typeof c === "string") return c;
  if (c !== null && typeof c === "object" && typeof c.id === "string") return c.id;
  return "";
}

function mapSubscription(sub: SubShape): RemoteSubscription {
  const item = sub.items?.data?.[0];
  const meta = sub.metadata ?? {};
  return {
    vendorCustomerId: customerId(sub.customer),
    vendorSubscriptionId: sub.id,
    vendorPriceId: item?.price?.id ?? "",
    status: sub.status as SubscriptionStatus,
    currentPeriodEndEpoch: typeof item?.current_period_end === "number" ? item.current_period_end : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    userId: typeof meta["user_id"] === "string" ? meta["user_id"] : null,
    planId: typeof meta["plan_id"] === "string" ? meta["plan_id"] : null,
  };
}

function vendorError(e: unknown): BillingError {
  return new BillingError("vendor", redactSecrets(e instanceof Error ? e.message : String(e)));
}

function reqOpts(idempotencyKey?: string): { idempotencyKey: string } | undefined {
  return idempotencyKey === undefined ? undefined : { idempotencyKey };
}

export const adapter: BillingAdapter = {
  name: "stripe",
  webhookSignatureHeader: "stripe-signature",

  async createCheckout(args: CheckoutArgs): Promise<CheckoutSession> {
    const stripe = getStripe();
    const metadata: Record<string, string> = { user_id: args.userId };
    if (args.planId !== undefined) metadata["plan_id"] = args.planId;
    try {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          line_items: [{ price: args.priceId, quantity: 1 }],
          success_url: args.successUrl,
          cancel_url: args.cancelUrl,
          client_reference_id: args.userId,
          subscription_data: { metadata },
          allow_promotion_codes: true,
          ...(args.customerEmail !== undefined ? { customer_email: args.customerEmail } : {}),
        },
        reqOpts(args.idempotencyKey),
      );
      if (session.url === null || session.url === undefined) {
        throw new BillingError("vendor", "Stripe returned a checkout session with no url");
      }
      return { id: session.id, url: session.url };
    } catch (e) {
      throw e instanceof BillingError ? e : vendorError(e);
    }
  },

  async setCancelAtPeriodEnd(
    vendorSubscriptionId: string,
    cancel: boolean,
    idempotencyKey?: string,
  ): Promise<RemoteSubscription> {
    const stripe = getStripe();
    try {
      const sub = await stripe.subscriptions.update(
        vendorSubscriptionId,
        { cancel_at_period_end: cancel },
        reqOpts(idempotencyKey),
      );
      return mapSubscription(sub as unknown as SubShape);
    } catch (e) {
      throw vendorError(e);
    }
  },

  async changePlan(
    vendorSubscriptionId: string,
    newPriceId: string,
    proration: ProrationBehavior,
    idempotencyKey?: string,
  ): Promise<RemoteSubscription> {
    const stripe = getStripe();
    try {
      const current = (await stripe.subscriptions.retrieve(vendorSubscriptionId)) as unknown as SubShape;
      const itemId = current.items?.data?.[0]?.id;
      if (itemId === undefined) {
        throw new BillingError("vendor", "subscription has no items to change");
      }
      const updated = await stripe.subscriptions.update(
        vendorSubscriptionId,
        { items: [{ id: itemId, price: newPriceId }], proration_behavior: proration },
        reqOpts(idempotencyKey),
      );
      return mapSubscription(updated as unknown as SubShape);
    } catch (e) {
      throw e instanceof BillingError ? e : vendorError(e);
    }
  },

  verifyAndParseWebhook(
    rawBody: Uint8Array,
    signatureHeader: string,
    nowEpochSeconds: number,
  ): NeutralBillingEvent {
    const secret = requireEnv("BILLING_WEBHOOK_SECRET");

    let t: string | null = null;
    const v1s: string[] = [];
    for (const el of signatureHeader.split(",")) {
      const i = el.indexOf("=");
      if (i === -1) continue;
      const k = el.slice(0, i).trim();
      const v = el.slice(i + 1).trim();
      if (k === "t") t = v;
      else if (k === "v1") v1s.push(v);
    }
    if (t === null) throw new BillingError("invalid_signature", "Stripe-Signature carries no t= element");
    if (v1s.length === 0) {
      throw new BillingError("invalid_signature", "Stripe-Signature carries no v1= element");
    }

    const body = Buffer.from(rawBody);
    const expected = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${t}.`, "utf8"), body]))
      .digest();
    const ok = v1s.some((v) => {
      const cand = Buffer.from(v, "hex");
      return cand.length === expected.length && timingSafeEqual(cand, expected);
    });
    if (!ok) {
      throw new BillingError("invalid_signature", "signature did not verify over the raw payload bytes");
    }

    // Window check AFTER signature → an out-of-window result is an authentic-but-stale delivery.
    const ts = Number(t);
    if (!Number.isFinite(ts) || Math.abs(nowEpochSeconds - ts) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new BillingError(
        "timestamp_out_of_window",
        `signed timestamp outside the ±${SIGNATURE_TOLERANCE_SECONDS}s window`,
      );
    }

    let evt: { id?: unknown; type?: unknown; created?: unknown; data?: { object?: unknown } };
    try {
      evt = JSON.parse(body.toString("utf8"));
    } catch {
      throw new BillingError("invalid_signature", "payload is not valid JSON after verification");
    }
    // event.created orders the mirror upsert (out-of-order guard); fall back to
    // the verified header timestamp, which is within ±300s of emission.
    const createdEpoch =
      typeof evt.created === "number" && Number.isFinite(evt.created) ? evt.created : ts;
    return mapEvent(evt, createdEpoch);
  },
};

function mapEvent(
  evt: { id?: unknown; type?: unknown; data?: { object?: unknown } },
  createdEpoch: number,
): NeutralBillingEvent {
  const id = typeof evt.id === "string" ? evt.id : "";
  const rawType = typeof evt.type === "string" ? evt.type : "";
  const obj = (evt.data?.object ?? {}) as SubShape & {
    subscription?: unknown;
    parent?: { subscription_details?: { subscription?: unknown } };
  };

  switch (rawType) {
    case "customer.subscription.created":
      return { id, rawType, createdEpoch, action: { kind: "subscription.created", subscription: mapSubscription(obj) } };
    case "customer.subscription.updated":
      return { id, rawType, createdEpoch, action: { kind: "subscription.updated", subscription: mapSubscription(obj) } };
    case "customer.subscription.deleted":
      return {
        id,
        rawType,
        createdEpoch,
        action: { kind: "subscription.canceled", subscription: { ...mapSubscription(obj), status: "canceled" } },
      };
    case "invoice.payment_failed": {
      const subId = invoiceSubscriptionId(obj);
      return { id, rawType, createdEpoch, action: { kind: "payment.failed", userId: null, vendorSubscriptionId: subId } };
    }
    // checkout.session.completed / invoice.paid carry no new mirror state we
    // can build synchronously — the paired customer.subscription.* event does.
    default:
      return { id, rawType, createdEpoch, action: { kind: "ignored" } };
  }
}

function invoiceSubscriptionId(obj: {
  subscription?: unknown;
  parent?: { subscription_details?: { subscription?: unknown } };
}): string | null {
  if (typeof obj.subscription === "string") return obj.subscription;
  const nested = obj.parent?.subscription_details?.subscription;
  return typeof nested === "string" ? nested : null;
}
