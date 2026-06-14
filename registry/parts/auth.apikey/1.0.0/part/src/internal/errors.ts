/**
 * The verification codes (`malformed`, `invalid`, `expired`, `revoked`,
 * `forbidden`) are the security-relevant ones — they are what a caller learns
 * when a key is rejected, and they are deliberately stingy: a random guesser
 * only ever sees `malformed` or `invalid`, never anything that confirms a key
 * existed (contract invariant 3). The operational codes (`invalid_input`,
 * `not_found`, `storage`) cover management calls and database failures.
 */
export type ApiKeyErrorCode =
  | "malformed" // the presented value is not a well-formed key (bad shape/charset)
  | "invalid" // unknown prefix or wrong secret — indistinguishable on purpose
  | "expired" // the key (or its rotation grace) has elapsed; only after a secret match
  | "revoked" // the key was revoked; only after a secret match
  | "forbidden" // the key is valid but lacks a required scope
  | "invalid_input" // issueKey/rotateKey was given bad arguments
  | "not_found" // rotateKey/revokeKey referenced an id that does not exist
  | "storage"; // the SqlExecutor (database) failed

/**
 * The only error type that escapes the part. A storage failure is wrapped as
 * `storage` with a GENERIC message — the raw driver error (which may carry
 * credentials or row data) is attached as `cause` for debugging but never put
 * in `message`, so it cannot leak through logs that print only the message
 * (contract invariant 7). Secret material is never placed in any message.
 */
export class ApiKeyError extends Error {
  readonly code: ApiKeyErrorCode;

  constructor(code: ApiKeyErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "ApiKeyError";
    this.code = code;
  }
}
