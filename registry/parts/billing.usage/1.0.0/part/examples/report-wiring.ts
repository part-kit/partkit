/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * Drive reportDue() on a schedule to push unreported usage to the biller (the
 * selected adapter, e.g. Stripe Meters). reportDue owns its own drain state, so
 * whatever calls it is just a CLOCK — no hard dependency on jobs.queue. If you
 * bill from the ledger yourself, you never call this at all.
 *
 * After copying, change the import to your alias (seams.md §1):
 *   import { usage, type SqlExecutor } from "@parts/billing.usage";
 */
import { usage, type SqlExecutor } from "../src/index";

/**
 * (1) PRODUCTION PATH — under jobs.queue. jobs.queue's TaskHandlers is
 * structurally `Record<string, (payload: unknown) => void | Promise<void>>`;
 * add this entry and fire it from a cron item on a few-minute pattern, e.g.
 *   runWorker({ connectionString, tasks, cron: [{ task: "report_usage", pattern: "every-5-min" }] })
 */
export function usageTasks(db: SqlExecutor): Record<string, () => Promise<void>> {
  return {
    report_usage: async () => {
      const report = await usage(db).reportDue({ batch: 500 });
      void report; // optional: log report.{reported,failed}
    },
  };
}

/**
 * (2) STANDALONE PATH — a plain OS/platform cron, no jobs.queue. Drain in
 * batches until nothing more is unreported this run.
 */
export async function cronReport(db: SqlExecutor): Promise<void> {
  const meter = usage(db);
  let total = 0;
  for (;;) {
    const report = await meter.reportDue({ batch: 500 });
    total += report.reported + report.failed;
    if (report.reported + report.failed === 0 || total >= 5000) break; // bound the work per run
  }
}
