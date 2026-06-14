import { BillingError } from "./errors";
import { BillingStore } from "./store";
import type {
  Billing,
  BillingAdapter,
  CancelInput,
  ChangePlanInput,
  CreateCheckoutInput,
  CheckoutSession,
  IngestResult,
  IngestWebhookInput,
  NeutralAction,
  RemoteSubscription,
  Subscription,
  SubscriptionChangeEvent,
  SubscriptionChangeHandler,
  SubscriptionStatus,
  SqlExecutor,
  Unsubscribe,
} from "./types";

const ENTITLED_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(["active", "trialing"]);

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}
function asIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Map a DB row → the public Subscription (entitled is derived, never stored). */
function rowToSubscription(row: Record<string, unknown>): Subscription {
  const status = asString(row["status"]) as SubscriptionStatus;
  const planId = row["plan_id"];
  return {
    id: asString(row["id"]),
    userId: asString(row["user_id"]),
    stripeCustomerId: asString(row["stripe_customer_id"]),
    stripeSubscriptionId: asString(row["stripe_subscription_id"]),
    planId: planId === null || planId === undefined ? null : asString(planId),
    stripePriceId: asString(row["stripe_price_id"]),
    status,
    currentPeriodEnd: asIso(row["current_period_end"]),
    cancelAtPeriodEnd: row["cancel_at_period_end"] === true,
    entitled: ENTITLED_STATUSES.has(status),
    createdAt: asIso(row["created_at"]) ?? "",
    updatedAt: asIso(row["updated_at"]) ?? "",
  };
}

/** Project a RemoteSubscription onto an existing mirror row for an OPTIMISTIC
 *  return after a write call. No DB write happens here — the authoritative
 *  mirror update arrives via the customer.subscription.updated webhook
 *  (invariant: state derives solely from verified events). */
function optimistic(existing: Subscription, remote: RemoteSubscription): Subscription {
  return {
    ...existing,
    status: remote.status,
    stripePriceId: remote.vendorPriceId,
    cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
    currentPeriodEnd:
      remote.currentPeriodEndEpoch === null
        ? existing.currentPeriodEnd
        : new Date(remote.currentPeriodEndEpoch * 1000).toISOString(),
    entitled: ENTITLED_STATUSES.has(remote.status),
    planId: remote.planId ?? existing.planId,
  };
}

class BillingImpl implements Billing {
  private readonly store: BillingStore;
  private readonly handlers = new Set<SubscriptionChangeHandler>();

  constructor(
    db: SqlExecutor,
    private readonly adapter: BillingAdapter,
  ) {
    this.store = new BillingStore(db);
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    if (typeof input.userId !== "string" || input.userId.trim() === "") {
      throw new BillingError("invalid_input", "userId is required");
    }
    if (typeof input.planId !== "string" || input.planId.trim() === "") {
      throw new BillingError("invalid_input", "planId is required");
    }
    const plan = input.catalog.get(input.planId);
    if (plan === null) {
      throw new BillingError("invalid_input", `unknown planId "${input.planId}"`);
    }
    // No subscription row is written here — the mirror is webhook-derived.
    return this.adapter.createCheckout({
      userId: input.userId,
      priceId: plan.stripePriceId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      // The app plan id rides through vendor metadata so the mirror can store it.
      planId: input.planId,
      ...(input.userEmail !== undefined ? { customerEmail: input.userEmail } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  async getSubscription(userId: string): Promise<Subscription | null> {
    if (typeof userId !== "string" || userId.trim() === "") {
      throw new BillingError("invalid_input", "userId is required");
    }
    const row = await this.store.getByUser(userId);
    return row === null ? null : rowToSubscription(row);
  }

  private async setCancel(input: CancelInput, cancel: boolean): Promise<Subscription> {
    if (typeof input.subscriptionId !== "string" || input.subscriptionId.trim() === "") {
      throw new BillingError("invalid_input", "subscriptionId is required");
    }
    const row = await this.store.getById(input.subscriptionId);
    if (row === null) throw new BillingError("not_found", "subscription not found");
    const existing = rowToSubscription(row);
    const remote = await this.adapter.setCancelAtPeriodEnd(
      existing.stripeSubscriptionId,
      cancel,
      input.idempotencyKey,
    );
    return optimistic(existing, remote);
  }

  cancelAtPeriodEnd(input: CancelInput): Promise<Subscription> {
    return this.setCancel(input, true);
  }
  reactivate(input: CancelInput): Promise<Subscription> {
    return this.setCancel(input, false);
  }

  async changePlan(input: ChangePlanInput): Promise<Subscription> {
    if (typeof input.subscriptionId !== "string" || input.subscriptionId.trim() === "") {
      throw new BillingError("invalid_input", "subscriptionId is required");
    }
    const plan = input.catalog.get(input.newPlanId);
    if (plan === null) throw new BillingError("invalid_input", `unknown planId "${input.newPlanId}"`);
    const row = await this.store.getById(input.subscriptionId);
    if (row === null) throw new BillingError("not_found", "subscription not found");
    const existing = rowToSubscription(row);
    const remote = await this.adapter.changePlan(
      existing.stripeSubscriptionId,
      plan.stripePriceId,
      input.prorationBehavior ?? "create_prorations",
      input.idempotencyKey,
    );
    return optimistic(existing, remote);
  }

  async ingestWebhook(input: IngestWebhookInput): Promise<IngestResult> {
    const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
    // Throws invalid_signature / timestamp_out_of_window before any state change.
    const event = this.adapter.verifyAndParseWebhook(input.rawBody, input.signatureHeader, now);

    // Ordering matters because the ledger is append-only (we cannot un-mark a
    // failed apply): (1) upsert the mirror FIRST — it is idempotent, so a
    // failure here leaves the event UNrecorded and a redelivery safely retries
    // (no lost update); (2) record the event id; (3) fire in-process handlers
    // exactly once, only on the fresh delivery. A duplicate re-runs the
    // idempotent upsert (harmless) but never re-fires handlers.
    const pending = await this.applyMirror(event.action, event.createdEpoch);
    const fresh = await this.store.markEventProcessed(event.id, event.rawType);
    if (fresh && pending !== null) await this.fire(pending);
    return { eventId: event.id, type: event.rawType, applied: fresh };
  }

  /** The webhook route bound to THIS instance — so handlers registered via
   *  onSubscriptionChange on this instance actually fire when an event arrives. */
  webhookHandler(): (request: Request) => Promise<Response> {
    return (request: Request) => routeIngest(this, request);
  }

  /** Apply the (idempotent) mirror write and return the handler event to fire
   *  if the delivery turns out to be fresh — or null when there is nothing to
   *  fire (ignored events, or an unattributable subscription with no owner). */
  private async applyMirror(
    action: NeutralAction,
    createdEpoch: number,
  ): Promise<SubscriptionChangeEvent | null> {
    if (action.kind === "ignored") return null;

    if (action.kind === "payment.failed") {
      let sub: Subscription | null = null;
      if (action.vendorSubscriptionId !== null) {
        const row = await this.store.getByVendorId(action.vendorSubscriptionId);
        sub = row === null ? null : rowToSubscription(row);
      }
      return { type: "payment.failed", subscription: sub, userId: action.userId };
    }

    // subscription.created / updated / canceled → upsert the mirror.
    const r = action.subscription;
    // Resolve the owner: prefer the event's metadata, else the existing mirror.
    let userId = r.userId;
    if (userId === null) {
      const existing = await this.store.getByVendorId(r.vendorSubscriptionId);
      userId = existing === null ? null : asString(existing["user_id"]);
    }
    if (userId === null) return null; // unattributable (no metadata, no prior row) — recorded, no mirror

    const row = await this.store.upsertSubscription({
      userId,
      vendorCustomerId: r.vendorCustomerId,
      vendorSubscriptionId: r.vendorSubscriptionId,
      vendorPriceId: r.vendorPriceId,
      planId: r.planId,
      status: r.status,
      currentPeriodEndEpoch: r.currentPeriodEndEpoch,
      cancelAtPeriodEnd: r.cancelAtPeriodEnd,
      lastEventEpoch: createdEpoch,
    });
    return { type: action.kind, subscription: rowToSubscription(row) };
  }

  private async fire(e: SubscriptionChangeEvent): Promise<void> {
    for (const h of this.handlers) {
      try {
        await h(e);
      } catch {
        // In-process handler failures are the app's concern and must not break
        // the part's state machine — the mirror + ledger are already consistent,
        // and the event is recorded, so it will not be reprocessed.
      }
    }
  }

  onSubscriptionChange(handler: SubscriptionChangeHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

export function makeBilling(db: SqlExecutor, adapter: BillingAdapter): Billing {
  return new BillingImpl(db, adapter);
}

/**
 * Shared route logic the app mounts at POST /api/webhooks/billing. Reads the RAW
 * bytes (never pre-parsed), verifies + applies, and maps to the retry contract:
 *   200 — verified and (idempotently) applied; safe for Stripe to stop retrying.
 *   400 — signature/timestamp rejected; do NOT redeliver.
 *   500 — transient (config/storage/vendor); redelivery is safe (idempotency guards it).
 */
async function routeIngest(b: Billing, request: Request): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const signatureHeader = request.headers.get("stripe-signature") ?? "";
  try {
    const r = await b.ingestWebhook({ rawBody, signatureHeader });
    return new Response(JSON.stringify({ received: true, applied: r.applied }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    if (
      e instanceof BillingError &&
      (e.code === "invalid_signature" || e.code === "timestamp_out_of_window")
    ) {
      return new Response("invalid signature", { status: 400 });
    }
    return new Response("error", { status: 500 });
  }
}

/**
 * Standalone webhook handler with NO in-process handlers — use when the app
 * reacts by re-reading getSubscription. To have onSubscriptionChange handlers
 * fire, build one instance and use its webhookHandler():
 *   const b = billing(db); b.onSubscriptionChange(...); export const POST = b.webhookHandler();
 */
export function makeWebhookHandler(
  db: SqlExecutor,
  adapter: BillingAdapter,
): (request: Request) => Promise<Response> {
  return (request: Request) => routeIngest(makeBilling(db, adapter), request);
}
