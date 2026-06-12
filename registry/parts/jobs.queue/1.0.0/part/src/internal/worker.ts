/**
 * The processing side — wraps graphile-worker's `run` (long-running daemon) and
 * `runOnce` (serverless drain) behind one contract. The app's task handlers and
 * cron schedule are the composition seam; graphile-worker provides the
 * retry/backoff/dead-letter engine and the crontab scheduler.
 *
 * graphile-worker is loaded with a DYNAMIC import, only when a worker shape is
 * actually called. Types come via `import type` (erased at build). So importing
 * the part's public surface for the serverless-safe enqueue/read seam never
 * statically pulls graphile-worker (or its pg driver) into the bundle, and
 * importing the part performs no I/O (contract invariant 1).
 */
import type {
  CronItem as GwCronItem,
  ParsedCronItem,
  Runner,
  RunnerOptions,
  TaskList,
} from "graphile-worker";
import { JobsError } from "./errors";
import type { RunningWorker, WorkerConfig } from "./types";
import { validateWorkerConfig } from "./validate";

type GraphileWorker = typeof import("graphile-worker");

/** Adapt the app's `(payload) => …` handlers to graphile-worker's task list. */
function buildTaskList(config: WorkerConfig): TaskList {
  const list: TaskList = {};
  for (const name of Object.keys(config.tasks)) {
    const handler = config.tasks[name]!;
    list[name] = async (payload): Promise<void> => {
      await handler(payload);
    };
  }
  return list;
}

/** Build graphile-worker cron items, surfacing a bad pattern as invalid_input. */
function buildCronItems(gw: GraphileWorker, config: WorkerConfig): ParsedCronItem[] | undefined {
  const schedule = config.cron ?? [];
  if (schedule.length === 0) return undefined;
  const items: GwCronItem[] = schedule.map((c) => ({
    task: c.task,
    match: c.pattern,
    identifier: c.identifier ?? c.task,
    ...(c.payload !== undefined ? { payload: c.payload } : {}),
    ...(c.backfillSeconds !== undefined
      ? { options: { backfillPeriod: c.backfillSeconds * 1000 } }
      : {}),
  }));
  try {
    return gw.parseCronItems(items);
  } catch (e) {
    // Config-time rejection of an invalid cron pattern (contract invariant 7).
    throw new JobsError(
      "invalid_input",
      `invalid cron schedule: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function buildOptions(gw: GraphileWorker, config: WorkerConfig): RunnerOptions {
  const cron = buildCronItems(gw, config);
  return {
    connectionString: config.connectionString,
    taskList: buildTaskList(config),
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    ...(config.pollInterval !== undefined ? { pollInterval: config.pollInterval } : {}),
    ...(cron !== undefined ? { parsedCronItems: cron } : {}),
  };
}

/**
 * Start a long-running worker (the server shape). Processes jobs continuously
 * with retry/backoff and runs the cron schedule. Returns a handle to stop it
 * gracefully and a `done` promise that resolves when it stops. NOT
 * serverless-safe by nature (a daemon) — use drainOnce on serverless.
 */
export async function runWorker(config: WorkerConfig): Promise<RunningWorker> {
  validateWorkerConfig(config);
  const gw: GraphileWorker = await import("graphile-worker");
  const options = buildOptions(gw, config); // may throw JobsError('invalid_input') on a bad cron pattern
  let runner: Runner;
  try {
    runner = await gw.run(options);
  } catch (e) {
    throw new JobsError("worker", "failed to start the worker", { cause: e });
  }
  return {
    stop: async (): Promise<void> => {
      try {
        await runner.stop();
      } catch (e) {
        throw new JobsError("worker", "failed to stop the worker", { cause: e });
      }
    },
    // Redact a crash: the raw error may carry the connection string.
    done: runner.promise.catch((e: unknown) => {
      throw new JobsError("worker", "the worker stopped with an error", { cause: e });
    }),
  };
}

/**
 * Process all currently-due jobs once, then resolve (the serverless shape).
 * Invoke this from a serverless function on your platform's cron — each call is
 * a single drain pass, no long-running process. Future/retry jobs whose run_at
 * has not arrived are left for a later pass.
 */
export async function drainOnce(config: WorkerConfig): Promise<void> {
  validateWorkerConfig(config);
  const gw: GraphileWorker = await import("graphile-worker");
  const options = buildOptions(gw, config);
  try {
    await gw.runOnce(options);
  } catch (e) {
    throw new JobsError("worker", "drain pass failed", { cause: e });
  }
}
