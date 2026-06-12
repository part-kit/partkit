/**
 * The driver-free database seam — the same minimal `node-postgres` Client/Pool
 * shape `partkit migrate` uses. The app wires its own `pg` Pool to this for the
 * enqueue/read paths; the part imports no driver on those paths (they are
 * serverless-safe and run in the app's transaction). Wiring: seams.md §2.
 */
export interface SqlExecutor {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** How `jobKey` re-enqueues behave (graphile-worker semantics). */
export type JobKeyMode = "replace" | "preserve_run_at" | "unsafe_dedupe";

/** What the app enqueues. Only `task` is required. */
export interface EnqueueInput {
  /** Task identifier — must match a handler key in the worker config (§ seams.md §3). */
  task: string;
  /** JSON-serializable payload passed to the handler. Defaults to `{}`. */
  payload?: Record<string, unknown>;
  /** Run no earlier than this time. Defaults to now. */
  runAt?: Date;
  /** Retry budget before the job is dead-lettered. Defaults to the engine default. */
  maxAttempts?: number;
  /** Idempotency/dedup key — a second enqueue with the same key updates one job. */
  jobKey?: string;
  /** How `jobKey` updates an existing job. Defaults to `replace`. */
  jobKeyMode?: JobKeyMode;
  /** Lower runs first. Defaults to 0. */
  priority?: number;
  /** Run jobs in this named queue serially (one at a time). */
  queueName?: string;
}

/** The stored job, as returned by enqueue. */
export interface EnqueuedJob {
  /** Job id (bigint serialized as string). */
  id: string;
  task: string;
  /** When it is due to run. */
  runAt: Date;
}

/** A dead-lettered job — one that exhausted its attempts. */
export interface FailedJob {
  id: string;
  task: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  /** The error message from the final failed attempt. */
  lastError: string | null;
  runAt: Date;
  createdAt: Date;
  queueName: string | null;
}

/** Filter for `listFailed`. */
export interface FailedFilter {
  /** Only failures of this task. */
  task?: string;
  /** Max rows, 1..1000, default 100. */
  limit?: number;
}

/** A job handler — your domain logic. The payload is whatever was enqueued. */
export type TaskHandler = (payload: unknown) => void | Promise<void>;

/** The task map: identifier → handler. The composition seam (seams.md §3). */
export type TaskHandlers = Record<string, TaskHandler>;

/** One recurring schedule (jobs.cron@1). */
export interface CronItem {
  /** Task identifier to enqueue on the schedule (needs a handler, like any job). */
  task: string;
  /** Cron pattern, `m h dom mon dow` (e.g. `0 3 * * *` = 03:00 daily). */
  pattern: string;
  /** Payload merged into the scheduled job. */
  payload?: Record<string, unknown>;
  /** Dedup identifier for this schedule; defaults to `task`. */
  identifier?: string;
  /** Backfill missed runs within this many seconds of startup (0 = no backfill). */
  backfillSeconds?: number;
}

/** A cron schedule: zero or more recurring items (jobs.cron@1). */
export type CronSchedule = CronItem[];

/** Config for both worker shapes. */
export interface WorkerConfig {
  /** Postgres connection string for the queue (the same DB partkit migrate set up). */
  connectionString: string;
  /** identifier → handler. The app's job logic (seams.md §3). */
  tasks: TaskHandlers;
  /** Jobs run concurrently (daemon only). Defaults to the engine default. */
  concurrency?: number;
  /** Poll interval in ms for future/retry jobs (daemon only). */
  pollInterval?: number;
  /** Recurring schedules (jobs.cron@1). Executed by the daemon shape. */
  cron?: CronSchedule;
}

/** A running daemon worker (runWorker). */
export interface RunningWorker {
  /** Gracefully stop: finish in-flight jobs, then resolve. */
  stop(): Promise<void>;
  /** Resolves when the worker stops (or rejects if it crashes). */
  done: Promise<void>;
}

/** The enqueue + dead-letter read surface, bound to one SqlExecutor by `jobs(db)`. */
export interface Jobs {
  /** Enqueue a job (serverless-safe, transactional via the seam). */
  enqueue(input: EnqueueInput): Promise<EnqueuedJob>;
  /** The dead-letter read: jobs that exhausted their attempts. */
  listFailed(filter?: FailedFilter): Promise<FailedJob[]>;
}
