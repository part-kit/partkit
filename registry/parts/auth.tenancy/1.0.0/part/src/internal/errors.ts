export type TenancyErrorCode =
  | "invalid_input"
  | "not_found"
  | "already_member"
  | "not_a_member"
  | "forbidden"
  | "last_owner"
  | "storage";

/**
 * The only error type that escapes the part. Validation mistakes throw
 * `invalid_input`; authorization failures throw `forbidden`; the business rules
 * throw `already_member` / `not_a_member` / `not_found` / `last_owner`. An
 * executor (database) failure is wrapped as `storage` with a GENERIC message —
 * the raw driver error (which may carry credentials or row data) is attached as
 * `cause` for debugging but never put in `message`, so it cannot leak through
 * logs that print only the message (contract invariant 1).
 */
export class TenancyError extends Error {
  readonly code: TenancyErrorCode;

  constructor(code: TenancyErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "TenancyError";
    this.code = code;
  }
}
