/**
 * billing.subscription — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 *
 * Subscription billing over a vendor-neutral contract: hosted checkout, a
 * webhook-derived subscription mirror, cancel/reactivate/change-plan, and a
 * derived `entitled` flag. The selected payment adapter (Stripe in v1) is the
 * vendor seam; state lives in the app's Postgres via the SqlExecutor seam.
 * Importing this module performs no I/O.
 */
import { adapter } from "../adapters/selected/adapter";
import { makeBilling, makeWebhookHandler } from "./internal/billing";
import type { Billing, SqlExecutor } from "./internal/types";

/** Bind the billing operations to the app's database seam + the selected adapter. */
export function billing(db: SqlExecutor): Billing {
  return makeBilling(db, adapter);
}

/** The handler the app mounts at POST /api/webhooks/billing (raw body required). */
export function billingWebhookHandler(db: SqlExecutor): (request: Request) => Promise<Response> {
  return makeWebhookHandler(db, adapter);
}

export { BillingError } from "./internal/errors";
export type { BillingErrorCode } from "./internal/errors";
export type {
  Billing,
  CancelInput,
  ChangePlanInput,
  CheckoutSession,
  CreateCheckoutInput,
  IngestResult,
  IngestWebhookInput,
  Plan,
  PlanCatalog,
  ProrationBehavior,
  Subscription,
  SubscriptionChangeEvent,
  SubscriptionChangeHandler,
  SubscriptionStatus,
  SqlExecutor,
  Unsubscribe,
} from "./internal/types";
