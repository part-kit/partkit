/**
 * billing.usage · stripe adapter — reports usage to Stripe Meters (v1
 * meter events). Pulled in only when selected; the per-adapter `stripe`
 * dependency (RFC 0001) keeps the ledger core zero-dependency. The reporting
 * direction is OUTBOUND only — there is no inbound webhook to verify.
 *
 * subjectId is sent as the Stripe customer id (`stripe_customer_id`). When your
 * subjectId is not already a Stripe customer id (e.g. it is an auth.apikey id),
 * map it to the customer id in your app BEFORE recording, or record with the
 * customer id as the subject (seams.md §5).
 */
import Stripe from "stripe";
import { loadConfig, redactSecrets } from "../../src/internal/config";
import { UsageError } from "../../src/internal/errors";
import type { ReportableEvent, UsageAdapter } from "../../src/internal/types";

// Must equal contract.json adapters[].vendor_api and stripe@22's LatestApiVersion.
const API_VERSION = "2026-05-27.dahlia";
// Stripe rejects meter-event timestamps older than ~35 days (or >5 min future);
// stay a day inside that so late/backfilled events are still billable.
const STRIPE_MAX_AGE_SECONDS = 34 * 86_400;

let client: Stripe | null = null;
function getStripe(): Stripe {
  if (client !== null) return client;
  const cfg = loadConfig(); // throws UsageError("config") if BILLING_USAGE_SECRET_KEY is missing
  client = new Stripe(cfg.secretKey, {
    apiVersion: API_VERSION,
    appInfo: { name: "partkit/billing.usage", version: "1.0.0" },
    maxNetworkRetries: 2,
    // Bound each request so a hung biller can't blow past reportDue's pass budget.
    timeout: 10_000,
  });
  return client;
}

/** Test-only memo reset, so the live conformance block can re-key the client. */
export function __resetForTests(): void {
  client = null;
}

function vendorError(e: unknown): UsageError {
  return new UsageError("vendor", redactSecrets(e instanceof Error ? e.message : String(e)));
}

async function report(event: ReportableEvent): Promise<{ reportedId?: string }> {
  const stripe = getStripe();
  // Clamp the event time into Stripe's accepted window. A late/backfilled event
  // older than ~35 days would otherwise be REJECTED and never billed; clamping
  // reports it into the current period (still billed) instead of losing it. For
  // exact-period backfill, invoice from the ledger directly (seams.md §6).
  const nowSec = Math.floor(Date.now() / 1000);
  const occurredSec = Math.floor(event.occurredAt.getTime() / 1000);
  const timestamp = Math.max(nowSec - STRIPE_MAX_AGE_SECONDS, Math.min(occurredSec, nowSec + 60));
  try {
    const created = await stripe.billing.meterEvents.create(
      {
        event_name: event.meter,
        // `identifier` is Stripe's in-band dedupe key (≥24h uniqueness window);
        // the request-header idempotencyKey is the secondary guard. Both are the
        // stable ledger eventId, so a re-report within the window never
        // double-bills (invariant 4; beyond the window it is at-least-once).
        identifier: event.eventId,
        timestamp,
        // Stripe meter-event payload values are strings; quantity is the EXACT
        // ledger string (not a rounded JS number), so billing stays byte-exact.
        payload: { stripe_customer_id: event.subjectId, value: event.quantity },
      },
      { idempotencyKey: event.eventId },
    );
    const identifier = (created as { identifier?: string }).identifier;
    return { reportedId: identifier ?? event.eventId };
  } catch (e) {
    throw e instanceof UsageError ? e : vendorError(e);
  }
}

export const adapter: UsageAdapter = { name: "stripe", report };
