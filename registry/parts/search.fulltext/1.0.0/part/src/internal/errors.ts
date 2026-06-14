/**
 * The only error type that escapes the part. `invalid_input` = bad arguments;
 * `storage` wraps a database failure with a GENERIC message — the raw driver
 * error is on `cause` for debugging but never in `message` (contract invariant
 * 1). Note: a malformed search query is NOT an error — raw user input is handled
 * safely by websearch_to_tsquery (invariant 3).
 */
export type SearchErrorCode = "invalid_input" | "storage";

export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "SearchError";
    this.code = code;
  }
}
