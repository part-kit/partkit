/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * Your job handlers (the composition seam) and a transactional enqueue helper.
 * Handlers throw to trigger a retry; the part owns the retry/backoff/dead-letter.
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { jobs, type TaskHandlers } from "@parts/jobs.queue";
 */
import { jobs, type SqlExecutor, type TaskHandlers } from "../src/index";

/** identifier → handler. Every `task` you enqueue must be a key here. */
export const tasks: TaskHandlers = {
  send_welcome_email: async (payload) => {
    const { userId } = payload as { userId: string };
    // ... send the email (e.g. via your email.transactional part).
    // Throwing here schedules a retry with backoff.
    void userId;
  },
  rebuild_search_index: async () => {
    // ... a periodic maintenance job (see the cron schedule in worker-entrypoint.ts).
  },
};

/**
 * Enqueue a welcome email. Pass a pooled client mid-transaction (db) so the job
 * commits with the sign-up that triggered it. The jobKey makes it idempotent —
 * a double sign-up submit enqueues one email, not two.
 */
export async function enqueueWelcome(db: SqlExecutor, userId: string): Promise<string> {
  const { id } = await jobs(db).enqueue({
    task: "send_welcome_email",
    payload: { userId },
    jobKey: `welcome:${userId}`,
    maxAttempts: 5,
  });
  return id;
}
