/**
 * The only error type that escapes the part — and ONLY from management ops
 * (setFlag/getFlag/listFlags/archiveFlag). `evaluate`/`evaluateAll` never throw
 * (they are fail-safe, contract invariant 1). `invalid_input` = bad arguments;
 * `storage` wraps a database failure with a generic message (the raw driver
 * error never escapes).
 */
export type FlagErrorCode = "invalid_input" | "storage";

export class FlagError extends Error {
  readonly code: FlagErrorCode;

  constructor(code: FlagErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "FlagError";
    this.code = code;
  }
}
