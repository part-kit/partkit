/**
 * jobs.queue — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 *
 * Provides jobs.queue@1 (durable background jobs with retry/backoff/dead-letter)
 * and jobs.cron@1 (recurring scheduled jobs). enqueue + the dead-letter read run
 * through the app-provided SqlExecutor seam (serverless-safe, transactional); the
 * worker shapes wrap graphile-worker. Importing this module performs no I/O and
 * never statically loads graphile-worker (the worker loads it on demand).
 */
import { JobsError } from "./internal/errors";
import { ENQUEUE_SQL, LIST_FAILED_SQL, rowToEnqueued, rowToFailedJob } from "./internal/sql";
import type {
  EnqueueInput,
  EnqueuedJob,
  FailedFilter,
  FailedJob,
  Jobs,
  SqlExecutor,
} from "./internal/types";
import { validateEnqueue, validateFailedFilter } from "./internal/validate";

export { JobsError } from "./internal/errors";
export type { JobsErrorCode } from "./internal/errors";
export { drainOnce, runWorker } from "./internal/worker";
export type {
  CronItem,
  CronSchedule,
  EnqueueInput,
  EnqueuedJob,
  FailedFilter,
  FailedJob,
  JobKeyMode,
  Jobs,
  RunningWorker,
  SqlExecutor,
  TaskHandler,
  TaskHandlers,
  WorkerConfig,
} from "./internal/types";

/**
 * Bind the enqueue + dead-letter read operations to a database connection (the
 * SqlExecutor seam). Constructing it performs no I/O and never throws — input is
 * validated, and the database touched, only when a method runs (contract
 * invariant 1, serverless-safe). Pass a per-request executor from your pool; an
 * enqueue runs inside whatever transaction that executor carries.
 */
export function jobs(db: SqlExecutor): Jobs {
  return {
    enqueue: (input: EnqueueInput): Promise<EnqueuedJob> => enqueue(db, input),
    listFailed: (filter?: FailedFilter): Promise<FailedJob[]> => listFailed(db, filter ?? {}),
  };
}

async function enqueue(db: SqlExecutor, input: EnqueueInput): Promise<EnqueuedJob> {
  const v = validateEnqueue(input); // throws JobsError('invalid_input') before any SQL
  let result: { rows: Record<string, unknown>[] };
  try {
    result = await db.query(ENQUEUE_SQL, [
      v.task,
      v.payloadJson,
      v.queueName,
      v.runAt,
      v.maxAttempts,
      v.jobKey,
      v.priority,
      v.jobKeyMode,
    ]);
  } catch (e) {
    throw new JobsError("storage", "failed to enqueue job", { cause: e });
  }
  const row = result.rows[0];
  if (row === undefined) {
    throw new JobsError(
      "storage",
      "enqueue returned no row — is the graphile_worker migration applied (partkit migrate)?",
    );
  }
  return rowToEnqueued(row, v.task);
}

async function listFailed(db: SqlExecutor, filter: FailedFilter): Promise<FailedJob[]> {
  const v = validateFailedFilter(filter); // throws JobsError('invalid_input') before any SQL
  let result: { rows: Record<string, unknown>[] };
  try {
    result = await db.query(LIST_FAILED_SQL, [v.task, v.limit]);
  } catch (e) {
    throw new JobsError("storage", "failed to list failed jobs", { cause: e });
  }
  return result.rows.map(rowToFailedJob);
}
