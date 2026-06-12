import { JobsError } from "./errors";
import type {
  EnqueueInput,
  FailedFilter,
  JobKeyMode,
  WorkerConfig,
} from "./types";

/**
 * Validation runs before any work: invalid input fails fast with
 * JobsError('invalid_input') and zero side effects (contract invariant 2).
 */

const MAX_IDENT = 256;
const MAX_KEY = 512;
const MAX_PAYLOAD_BYTES = 262_144; // 256 KiB serialized
const MAX_ATTEMPTS = 1_000_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const JOB_KEY_MODES: readonly JobKeyMode[] = ["replace", "preserve_run_at", "unsafe_dedupe"];

function invalid(detail: string): JobsError {
  return new JobsError("invalid_input", detail);
}

/** Normalized enqueue, ready for the add_job SQL params. */
export interface ValidatedEnqueue {
  task: string;
  payloadJson: string;
  queueName: string | null;
  runAt: Date | null;
  maxAttempts: number | null;
  jobKey: string | null;
  jobKeyMode: JobKeyMode;
  priority: number | null;
}

function requireIdent(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${label} is required and must be a non-empty string`);
  }
  if (value.length > MAX_IDENT) throw invalid(`${label} exceeds ${MAX_IDENT} characters`);
  return value;
}

function optInt(value: unknown, label: string, min: number, max: number): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalid(`${label} must be an integer in ${min}..${max}`);
  }
  return value as number;
}

export function validateEnqueue(input: EnqueueInput): ValidatedEnqueue {
  const task = requireIdent(input.task, "task");

  const payload = input.payload ?? {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw invalid("payload must be a plain object");
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (e) {
    throw invalid(`payload is not JSON-serializable: ${e instanceof Error ? e.message : "?"}`);
  }
  if (payloadJson === undefined) throw invalid("payload is not JSON-serializable");
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw invalid(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes when serialized`);
  }

  let queueName: string | null = null;
  if (input.queueName !== undefined) queueName = requireIdent(input.queueName, "queueName");

  if (input.runAt !== undefined && !(input.runAt instanceof Date)) {
    throw invalid("runAt must be a Date");
  }
  const runAt = input.runAt ?? null;

  const maxAttempts = optInt(input.maxAttempts, "maxAttempts", 1, MAX_ATTEMPTS);
  const priority = optInt(input.priority, "priority", -32_768, 32_767);

  let jobKey: string | null = null;
  if (input.jobKey !== undefined) {
    if (typeof input.jobKey !== "string" || input.jobKey === "") {
      throw invalid("jobKey must be a non-empty string");
    }
    if (input.jobKey.length > MAX_KEY) throw invalid(`jobKey exceeds ${MAX_KEY} characters`);
    jobKey = input.jobKey;
  }

  let jobKeyMode: JobKeyMode = "replace";
  if (input.jobKeyMode !== undefined) {
    if (!JOB_KEY_MODES.includes(input.jobKeyMode)) {
      throw invalid(`jobKeyMode must be one of: ${JOB_KEY_MODES.join(", ")}`);
    }
    jobKeyMode = input.jobKeyMode;
  }

  return { task, payloadJson, queueName, runAt, maxAttempts, jobKey, jobKeyMode, priority };
}

export function validateFailedFilter(filter: FailedFilter): { task: string | null; limit: number } {
  let limit = DEFAULT_LIMIT;
  if (filter.limit !== undefined) {
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_LIMIT) {
      throw invalid(`limit must be an integer in 1..${MAX_LIMIT}`);
    }
    limit = filter.limit;
  }
  let task: string | null = null;
  if (filter.task !== undefined) task = requireIdent(filter.task, "task");
  return { task, limit };
}

/**
 * Validate worker config shape (connection, tasks, tunables, cron item shapes).
 * The cron PATTERN itself is validated by the engine when the schedule is built
 * (worker.ts), surfaced as the same invalid_input code (contract invariant 7).
 */
export function validateWorkerConfig(config: WorkerConfig): void {
  if (typeof config.connectionString !== "string" || config.connectionString.trim() === "") {
    throw invalid("connectionString is required and must be a non-empty string");
  }
  if (
    typeof config.tasks !== "object" ||
    config.tasks === null ||
    Array.isArray(config.tasks)
  ) {
    throw invalid("tasks must be an object of identifier → handler");
  }
  const taskNames = Object.keys(config.tasks);
  if (taskNames.length === 0) throw invalid("tasks must define at least one handler");
  for (const name of taskNames) {
    if (name.trim() === "" || name.length > MAX_IDENT) {
      throw invalid(`task name "${name}" is invalid`);
    }
    if (typeof config.tasks[name] !== "function") {
      throw invalid(`handler for "${name}" must be a function`);
    }
  }
  optInt(config.concurrency, "concurrency", 1, 1000);
  optInt(config.pollInterval, "pollInterval", 1, 2_147_483_647);

  for (const item of config.cron ?? []) {
    requireIdent(item.task, "cron.task");
    if (typeof item.pattern !== "string" || item.pattern.trim() === "") {
      throw invalid("cron.pattern is required and must be a non-empty string");
    }
    if (item.identifier !== undefined) requireIdent(item.identifier, "cron.identifier");
    optInt(item.backfillSeconds, "cron.backfillSeconds", 0, 31_536_000);
  }
}
