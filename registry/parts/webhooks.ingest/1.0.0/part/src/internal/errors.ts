export type WebhookErrorCode =
  | "config"
  | "missing_header"
  | "invalid_signature"
  | "timestamp_out_of_window"
  | "replayed"
  | "unknown";

/** Recommended HTTP response status per code (contract invariant 6). */
const STATUS: Record<WebhookErrorCode, number> = {
  config: 500,
  missing_header: 400,
  invalid_signature: 400,
  timestamp_out_of_window: 400,
  replayed: 400,
  unknown: 500,
};

/**
 * The only error type that escapes the part (contract invariant 6). `status`
 * is the HTTP status the app should answer the vendor with: 400s mean "do not
 * redeliver this request", 500s mean "our side is misconfigured, retry later".
 */
export class WebhookError extends Error {
  readonly code: WebhookErrorCode;
  readonly status: number;

  constructor(code: WebhookErrorCode, message: string) {
    super(message);
    this.name = "WebhookError";
    this.code = code;
    this.status = STATUS[code];
  }
}
