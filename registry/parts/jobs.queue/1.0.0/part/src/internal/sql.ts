import type { EnqueuedJob, FailedJob } from "./types";

/**
 * Constant, fully-parameterized statements against the part-owned
 * `graphile_worker` schema (contract invariant 8) — no input is ever
 * concatenated, so SQL metacharacters in task names, payloads, or job keys are
 * data, never code.
 *
 * Enqueue goes through graphile-worker's own `add_job` function rather than a
 * raw INSERT, so it stays correct across graphile-worker schema revisions and
 * runs inside whatever transaction the SqlExecutor seam carries.
 *
 * add_job parameters (positional): identifier, payload, queue_name, run_at,
 * max_attempts, job_key, priority, flags, job_key_mode.
 */
export const ENQUEUE_SQL = `SELECT j.id, j.run_at
FROM graphile_worker.add_job($1, $2::json, $3, $4, $5, $6, $7, NULL, $8) AS j`;

/**
 * The dead-letter read: jobs that exhausted their attempts (contract
 * invariant 5). The public `jobs` view carries the metadata but not the payload
 * (graphile-worker keeps payload on the backing table), so we join the
 * part-owned backing table by id to surface the failed job's data for
 * inspection/requeue. Both relations are in the part-owned graphile_worker
 * schema (invariant 8).
 */
export const LIST_FAILED_SQL = `SELECT j.id, j.task_identifier, p.payload, j.attempts, j.max_attempts, j.last_error, j.run_at, j.created_at, j.queue_name
FROM graphile_worker.jobs j
JOIN graphile_worker._private_jobs p ON p.id = j.id
WHERE j.attempts >= j.max_attempts AND j.last_error IS NOT NULL
  AND ($1::text IS NULL OR j.task_identifier = $1)
ORDER BY j.created_at DESC, j.id DESC
LIMIT $2`;

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** Map the add_job RETURNING row to the public EnqueuedJob. */
export function rowToEnqueued(row: Record<string, unknown>, task: string): EnqueuedJob {
  return { id: String(row["id"]), task, runAt: toDate(row["run_at"]) };
}

/** Map a `jobs`-view row to the public FailedJob. */
export function rowToFailedJob(row: Record<string, unknown>): FailedJob {
  return {
    id: String(row["id"]),
    task: String(row["task_identifier"]),
    payload: row["payload"] ?? null,
    attempts: Number(row["attempts"]),
    maxAttempts: Number(row["max_attempts"]),
    lastError:
      row["last_error"] === null || row["last_error"] === undefined
        ? null
        : String(row["last_error"]),
    runAt: toDate(row["run_at"]),
    createdAt: toDate(row["created_at"]),
    queueName:
      row["queue_name"] === null || row["queue_name"] === undefined
        ? null
        : String(row["queue_name"]),
  };
}
