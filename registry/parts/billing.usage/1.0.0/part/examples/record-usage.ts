/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * Record consumption on the hot path (fast + local), and read totals for a
 * dashboard or invoice. Recording NEVER calls the biller — that happens
 * out-of-band in reportDue (examples/report-wiring.ts).
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { usage, type SqlExecutor } from "@parts/billing.usage";
 */
import { usage, type SqlExecutor, type UsageTotal } from "../src/index";

/**
 * Meter one API call. Pass the request id as idempotencyKey so a retried
 * request never double-counts. The same request can record several meters with
 * the same key — the dedupe is scoped per (subject, meter).
 */
export async function meterApiCall(
  db: SqlExecutor,
  subjectId: string, // your customer/org id, OR the Stripe customer id if you'll report to Stripe
  requestId: string,
  inputTokens: number,
): Promise<void> {
  const meter = usage(db);
  await meter.record({ subjectId, meter: "api.request", quantity: 1, idempotencyKey: requestId });
  await meter.record({ subjectId, meter: "tokens.input", quantity: inputTokens, idempotencyKey: requestId });
}

/** This month's usage for a subject — feed an invoice preview or a usage page. */
export function usageThisMonth(
  db: SqlExecutor,
  subjectId: string,
  monthStart: Date,
): Promise<UsageTotal[]> {
  return usage(db).summary({ subjectId, since: monthStart });
}
