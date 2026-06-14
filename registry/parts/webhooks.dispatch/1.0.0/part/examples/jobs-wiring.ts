/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * How to drive deliverDue() on a schedule. The part owns retry/backoff/dead-
 * letter in its outbox, so whatever calls deliverDue is just a CLOCK — there is
 * no hard dependency on jobs.queue.
 *
 * After copying, change the import to your alias (seams.md §1):
 *   import { dispatcher, type SqlExecutor } from "@parts/webhooks.dispatch";
 */
import { dispatcher, type SqlExecutor } from "../src/index";

/**
 * (1) PRODUCTION PATH — under jobs.queue. jobs.queue's TaskHandlers is
 * structurally `Record<string, (payload: unknown) => void | Promise<void>>`;
 * add this entry to your task map and fire it from a cron item, e.g.
 *   runWorker({ connectionString, tasks, cron: [{ task: "deliver_due_webhooks", pattern: "* * * * *" }] })
 * On serverless, point the platform cron at a guarded route that calls
 * deliverDue directly. Keep ONE drain running at a time.
 */
export function dispatchTasks(db: SqlExecutor): Record<string, () => Promise<void>> {
  return {
    deliver_due_webhooks: async () => {
      const report = await dispatcher(db).deliverDue({ batch: 100 });
      // optional: log report.{attempted,delivered,retried,dead}
      void report;
    },
  };
}

/**
 * (2) STANDALONE PATH — a plain OS/platform cron, no jobs.queue at all. Point a
 * `* * * * *` cron at a tiny entrypoint that constructs the dispatcher and calls
 * deliverDue(). Because deliverDue owns its own retry state, this is all you need.
 */
export async function cronDrain(db: SqlExecutor): Promise<void> {
  let total = 0;
  // Drain in batches until nothing more is due this minute.
  for (;;) {
    const report = await dispatcher(db).deliverDue({ batch: 200 });
    total += report.attempted;
    if (report.attempted === 0 || total >= 2000) break; // bound the work per run
  }
}
