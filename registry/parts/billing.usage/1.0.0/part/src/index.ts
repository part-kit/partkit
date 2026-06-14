/**
 * billing.usage — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 *
 * The vendor-neutral metered-usage ledger: record events idempotently, aggregate
 * per subject/meter/period, and report unreported usage to a biller (Stripe
 * Meters) out-of-band. The ledger is the source of truth — invoice from it
 * yourself or push to Stripe; the biller is an adapter, not the foundation.
 */
import { adapter } from "../adapters/selected/adapter";
import { makeUsage } from "./internal/usage";
import type { SqlExecutor, UsageMeter } from "./internal/types";

export { UsageError } from "./internal/errors";
export type { UsageErrorCode } from "./internal/errors";
export type {
  RecordedUsage,
  RecordUsageInput,
  ReportDueOptions,
  SqlExecutor,
  UsageMeter,
  UsageReport,
  UsageSummaryQuery,
  UsageTotal,
  UsageTotalQuery,
} from "./internal/types";

/**
 * Bind the usage meter to a database connection (the SqlExecutor seam).
 * Constructing it performs no I/O and never throws (contract invariant 1) — the
 * database is touched only when a method runs, so it is serverless-safe.
 *
 *   const meter = usage(db);
 *   await meter.record({ subjectId, meter: "api.request", quantity: 1, idempotencyKey: reqId });
 *   const t = await meter.total({ subjectId, meter: "api.request", since, until });
 *   // …then drive reportDue() from jobs.queue or a cron to push to the biller:
 *   await meter.reportDue();
 */
export function usage(db: SqlExecutor): UsageMeter {
  return makeUsage(db, adapter);
}
