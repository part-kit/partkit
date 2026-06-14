/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * The two call sites: register a customer endpoint (show the secret once), and
 * dispatch a domain event (enqueue-only — delivery is out-of-band, §5).
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { dispatcher, type SqlExecutor } from "@parts/webhooks.dispatch";
 */
import { dispatcher, type SqlExecutor } from "../src/index";

/**
 * Called from your "add webhook endpoint" settings handler. Return the secret to
 * render it exactly once ("copy it now — you won't see it again"); never store it
 * yourself. The customer uses it to verify your deliveries (Standard Webhooks).
 */
export async function addEndpoint(
  db: SqlExecutor,
  customerId: string,
  url: string,
): Promise<{ id: string; secret: string }> {
  // Throws DispatchError("invalid_url") for non-https or non-public destinations.
  return dispatcher(db).registerEndpoint({ ownerId: customerId, url });
}

/**
 * Call this wherever the event happens (e.g. after a successful charge). It
 * enqueues and returns immediately — it does NOT wait on the customer's server.
 * The idempotencyKey makes a re-run of this code path enqueue at most once.
 */
export async function emitInvoicePaid(
  db: SqlExecutor,
  endpointId: string,
  invoice: { id: string; amountCents: number },
): Promise<string> {
  const { messageId } = await dispatcher(db).dispatch({
    endpointId,
    eventType: "invoice.paid",
    payload: { invoiceId: invoice.id, amount: invoice.amountCents },
    idempotencyKey: `invoice.paid:${invoice.id}`,
  });
  return messageId;
}
