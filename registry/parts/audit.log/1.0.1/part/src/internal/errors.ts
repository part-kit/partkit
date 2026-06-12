export type AuditErrorCode = "invalid_event" | "invalid_query" | "storage";

/**
 * The only error type that escapes the part. Validation mistakes throw
 * `invalid_event` / `invalid_query`; an executor (database) failure is wrapped
 * as `storage` with a GENERIC message — the raw driver error (which may carry
 * credentials or row data) is attached as `cause` for debugging but never put
 * in `message`, so it cannot leak through logs that print only the message.
 */
export class AuditError extends Error {
  readonly code: AuditErrorCode;

  constructor(code: AuditErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "AuditError";
    this.code = code;
  }
}
