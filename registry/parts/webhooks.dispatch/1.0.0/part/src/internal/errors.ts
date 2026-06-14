/**
 * The typed errors callers see. `invalid_url` (SSRF/non-https/malformed) and
 * `unknown_endpoint` are the security-relevant register/dispatch codes;
 * `invalid_payload` covers other malformed input; `storage` wraps a database
 * failure with a GENERIC message — the raw driver error is on `cause`, never in
 * `message`, so credentials cannot leak through logs (contract invariant 1).
 */
export type DispatchErrorCode =
  | "invalid_url" // non-https, malformed, or a non-public (SSRF) destination
  | "unknown_endpoint" // dispatch referenced an endpoint id that does not exist
  | "invalid_payload" // payload not JSON-serializable, or other malformed input
  | "storage"; // the SqlExecutor (database) failed

export class DispatchError extends Error {
  readonly code: DispatchErrorCode;

  constructor(code: DispatchErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "DispatchError";
    this.code = code;
  }
}
