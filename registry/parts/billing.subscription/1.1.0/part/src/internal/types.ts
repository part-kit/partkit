/**
 * Public + internal types for billing.subscription.
 *
 * The PUBLIC surface (re-exported by src/index) is vendor-neutral: an app never
 * names Stripe in its types. The ADAPTER contract at the bottom is the vendor
 * seam — the selected payment adapter implements it; the facade in billing.ts
 * orchestrates the adapter + the SqlExecutor-backed mirror.
 */

/** The app-provided database seam (same shape as audit.log / auth.tenancy). */
export interface SqlExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Stripe subscription status values (the entitlement set is {active, trialing}). */
export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

/** An app plan mapped to a vendor price id. The app owns the catalog (a seam). */
export interface Plan {
  id: string;
  stripePriceId: string;
  label?: string;
}
export interface PlanCatalog {
  get(planId: string): Plan | null;
  list(): Plan[];
}

export interface CheckoutSession {
  id: string;
  url: string;
}

export interface CreateCheckoutInput {
  userId: string;
  planId: string;
  successUrl: string;
  cancelUrl: string;
  catalog: PlanCatalog;
  /** Used only to create the vendor Customer on first checkout. */
  userEmail?: string;
  /** Forwarded to the vendor write call to make a retried checkout safe. */
  idempotencyKey?: string;
}

/** The app-facing subscription mirror row. `entitled` is derived, never stored. */
export interface Subscription {
  id: string;
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  planId: string | null;
  stripePriceId: string;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  entitled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CancelInput {
  subscriptionId: string;
  idempotencyKey?: string;
}

export type ProrationBehavior = "create_prorations" | "none" | "always_invoice";

export interface ChangePlanInput {
  subscriptionId: string;
  newPlanId: string;
  catalog: PlanCatalog;
  prorationBehavior?: ProrationBehavior;
  idempotencyKey?: string;
}

export interface IngestWebhookInput {
  /** RAW request bytes — never JSON.parse'd before signature verification. */
  rawBody: Uint8Array;
  /** The value of the Stripe-Signature header. */
  signatureHeader: string;
  /** Injectable clock for tests; defaults to the wall clock. */
  nowEpochSeconds?: number;
}
export interface IngestResult {
  eventId: string;
  type: string;
  /** false ⇒ a duplicate delivery that was already processed. */
  applied: boolean;
}

export type SubscriptionChangeEvent =
  | { type: "subscription.created"; subscription: Subscription }
  | { type: "subscription.updated"; subscription: Subscription }
  | { type: "subscription.canceled"; subscription: Subscription }
  | { type: "payment.failed"; subscription: Subscription | null; userId: string | null };
export type SubscriptionChangeHandler = (e: SubscriptionChangeEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface Billing {
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  getSubscription(userId: string): Promise<Subscription | null>;
  cancelAtPeriodEnd(input: CancelInput): Promise<Subscription>;
  reactivate(input: CancelInput): Promise<Subscription>;
  changePlan(input: ChangePlanInput): Promise<Subscription>;
  ingestWebhook(input: IngestWebhookInput): Promise<IngestResult>;
  onSubscriptionChange(handler: SubscriptionChangeHandler): Unsubscribe;
  /** The POST /api/webhooks/billing route bound to THIS instance, so handlers
   *  registered via onSubscriptionChange fire when an event arrives. */
  webhookHandler(): (request: Request) => Promise<Response>;
}

/* ───────────────────────── adapter contract (vendor seam) ───────────────────────── */

/** A vendor-neutral snapshot the adapter derives from a vendor subscription object. */
export interface RemoteSubscription {
  vendorCustomerId: string;
  vendorSubscriptionId: string;
  vendorPriceId: string;
  status: SubscriptionStatus;
  currentPeriodEndEpoch: number | null;
  cancelAtPeriodEnd: boolean;
  /** Resolved from the vendor object's metadata.user_id / client_reference_id. */
  userId: string | null;
  /** The app plan id carried through vendor metadata.plan_id (null if absent). */
  planId: string | null;
}

export interface CheckoutArgs {
  userId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  idempotencyKey?: string;
  /** The app plan id; the adapter writes it to vendor subscription metadata. */
  planId?: string;
}

/** What the facade should do with a verified event. */
export type NeutralAction =
  | {
      kind: "subscription.created" | "subscription.updated" | "subscription.canceled";
      subscription: RemoteSubscription;
    }
  | { kind: "payment.failed"; userId: string | null; vendorSubscriptionId: string | null }
  | { kind: "ignored" };

/** The verified, vendor-neutral event the facade acts on. `rawType` is the
 *  vendor's own event type string (recorded in the ledger + returned);
 *  `createdEpoch` is the event's emission time (vendor event.created), used to
 *  guard the mirror upsert against out-of-order delivery. */
export interface NeutralBillingEvent {
  id: string;
  rawType: string;
  createdEpoch: number;
  action: NeutralAction;
}

/**
 * The payment-vendor seam. The selected adapter (adapters/selected/adapter)
 * implements it. Vendor write calls (checkout/cancel/change) hit the network;
 * verifyAndParseWebhook is pure CPU (HMAC over raw bytes) — no network, no SDK.
 */
export interface BillingAdapter {
  readonly name: string;
  /** The request header the vendor's webhook signature arrives in (e.g.
   *  "stripe-signature", "paddle-signature"). The route reads this header. */
  readonly webhookSignatureHeader: string;
  createCheckout(args: CheckoutArgs): Promise<CheckoutSession>;
  setCancelAtPeriodEnd(
    vendorSubscriptionId: string,
    cancel: boolean,
    idempotencyKey?: string,
  ): Promise<RemoteSubscription>;
  changePlan(
    vendorSubscriptionId: string,
    newPriceId: string,
    proration: ProrationBehavior,
    idempotencyKey?: string,
  ): Promise<RemoteSubscription>;
  verifyAndParseWebhook(
    rawBody: Uint8Array,
    signatureHeader: string,
    nowEpochSeconds: number,
  ): NeutralBillingEvent;
}
