export type EmailErrorCode =
  | "config"
  | "invalid_message"
  | "auth"
  | "rate_limited"
  | "rejected"
  | "vendor_unavailable"
  | "unknown";

/** The only error type that escapes the part (contract invariant 5). */
export class EmailError extends Error {
  readonly code: EmailErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    code: EmailErrorCode,
    message: string,
    opts: { retryable: boolean; status?: number },
  ) {
    super(message);
    this.name = "EmailError";
    this.code = code;
    this.retryable = opts.retryable;
    this.status = opts.status ?? null;
  }
}

/**
 * Map a vendor HTTP status to a typed error. Deliberately built from the
 * status alone: vendor response bodies are never read into error messages, so
 * raw vendor internals cannot escape the part (invariant 5).
 */
export function vendorHttpError(vendor: string, status: number): EmailError {
  if (status === 401 || status === 403) {
    return new EmailError(
      "auth",
      `${vendor}: authentication failed (HTTP ${status}) — check the adapter's API key env var`,
      { retryable: false, status },
    );
  }
  if (status === 429) {
    return new EmailError("rate_limited", `${vendor}: rate limited (HTTP 429)`, {
      retryable: true,
      status,
    });
  }
  if (status >= 500) {
    return new EmailError("vendor_unavailable", `${vendor}: vendor error (HTTP ${status})`, {
      retryable: true,
      status,
    });
  }
  if (status >= 400) {
    return new EmailError("rejected", `${vendor}: message rejected (HTTP ${status})`, {
      retryable: false,
      status,
    });
  }
  return new EmailError("unknown", `${vendor}: unexpected response (HTTP ${status})`, {
    retryable: false,
    status,
  });
}

export function vendorNetworkError(vendor: string, cause: unknown): EmailError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new EmailError("vendor_unavailable", `${vendor}: network failure (${detail})`, {
    retryable: true,
  });
}
