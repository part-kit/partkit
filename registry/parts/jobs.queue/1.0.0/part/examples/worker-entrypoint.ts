/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * The SERVER shape (seams.md §6): a dedicated long-running worker process.
 * Build it and run as e.g. `node dist/worker.js` in its own container/dyno.
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { runWorker } from "@parts/jobs.queue";
 */
import { runWorker } from "../src/index";
import { tasks } from "./tasks";

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined) throw new Error("DATABASE_URL is required");

  const worker = await runWorker({
    connectionString,
    tasks,
    concurrency: 5,
    // jobs.cron@1 — recurring schedules run inside this worker.
    cron: [
      { task: "rebuild_search_index", pattern: "*/15 * * * *", backfillSeconds: 3600 },
    ],
  });

  // graphile-worker installs graceful SIGTERM/SIGINT handlers by default, so a
  // platform stop drains in-flight jobs and resolves `done`. Await it to keep
  // the process alive until then.
  await worker.done;
}

void main();
