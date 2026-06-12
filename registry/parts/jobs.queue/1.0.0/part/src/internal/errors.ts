export type JobsErrorCode = "invalid_input" | "storage" | "worker";

/**
 * The only error type that escapes the part. Validation mistakes throw
 * `invalid_input`. A failure of the SqlExecutor seam (enqueue/listFailed) is
 * wrapped as `storage`; a failure of the worker engine (runWorker/drainOnce) is
 * wrapped as `worker`. In both wrapped cases the message is GENERIC — the raw
 * driver/library error (which may carry the connection string or row data) is
 * attached as `cause` for deliberate, scrubbed logging but never put in
 * `message` (contract invariant 1).
 */
export class JobsError extends Error {
  readonly code: JobsErrorCode;

  constructor(code: JobsErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "JobsError";
    this.code = code;
  }
}
