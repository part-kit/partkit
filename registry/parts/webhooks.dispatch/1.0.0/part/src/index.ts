/**
 * webhooks.dispatch — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 *
 * The verified OUTBOUND webhook sender: register customer endpoints, dispatch
 * signed events to an outbox (never inline), and deliver out-of-band with retry,
 * backoff, a delivery log, dead-letter, and SSRF defense. The API-facing sibling
 * of webhooks.ingest — same Standard Webhooks signature, so a customer verifies
 * our deliveries with the same code.
 */
import { createDispatcher } from "./internal/store";
import type { Dispatcher, SqlExecutor } from "./internal/types";

export { DispatchError } from "./internal/errors";
export type { DispatchErrorCode } from "./internal/errors";
export type {
  DeliverDueOptions,
  DeliveryAttempt,
  DeliveryOutcome,
  DeliveryReport,
  Dispatcher,
  DispatchInput,
  DispatchResult,
  RegisteredEndpoint,
  RegisterEndpointInput,
  SqlExecutor,
} from "./internal/types";

/**
 * Bind the dispatcher to a database connection (the SqlExecutor seam).
 * Constructing it performs no I/O and never throws (contract invariant 1) — the
 * database is touched only when a method runs, so it is serverless-safe. Pass a
 * per-request executor from your pool.
 *
 *   const wh = dispatcher(db);
 *   const { id, secret } = await wh.registerEndpoint({ ownerId, url });   // secret shown once
 *   await wh.dispatch({ endpointId: id, eventType: "invoice.paid", payload });
 *   // …then drive deliverDue() from jobs.queue or a cron (seams.md §5):
 *   await wh.deliverDue();
 */
export function dispatcher(db: SqlExecutor): Dispatcher {
  return createDispatcher(db);
}
