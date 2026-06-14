export type SmsErrorCode =
  | "config"
  | "invalid_message"
  | "auth"
  | "rate_limited"
  | "rejected"
  | "vendor_unavailable"
  | "unknown";

/** The only error type that escapes the part (contract invariant 5). */
export class SmsError extends Error {
  readonly code: SmsErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(code: SmsErrorCode, message: string, opts: { retryable: boolean; status?: number }) {
    super(message);
    this.name = "SmsError";
    this.code = code;
    this.retryable = opts.retryable;
    this.status = opts.status ?? null;
  }
}

/**
 * Map a vendor HTTP status to a typed error. Built from the status alone —
 * vendor response bodies are never read into error messages, so raw vendor
 * internals cannot escape the part (invariant 5).
 */
export function vendorHttpError(vendor: string, status: number): SmsError {
  if (status === 401 || status === 403) {
    return new SmsError(
      "auth",
      `${vendor}: authentication failed (HTTP ${status}) — check the adapter's credential env vars`,
      { retryable: false, status },
    );
  }
  if (status === 429) {
    return new SmsError("rate_limited", `${vendor}: rate limited (HTTP 429)`, { retryable: true, status });
  }
  if (status >= 500) {
    return new SmsError("vendor_unavailable", `${vendor}: vendor error (HTTP ${status})`, {
      retryable: true,
      status,
    });
  }
  if (status >= 400) {
    return new SmsError("rejected", `${vendor}: message rejected (HTTP ${status})`, {
      retryable: false,
      status,
    });
  }
  return new SmsError("unknown", `${vendor}: unexpected response (HTTP ${status})`, {
    retryable: false,
    status,
  });
}

export function vendorNetworkError(vendor: string, cause: unknown): SmsError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new SmsError("vendor_unavailable", `${vendor}: network failure (${detail})`, { retryable: true });
}
