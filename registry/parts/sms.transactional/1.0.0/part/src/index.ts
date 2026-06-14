/**
 * sms.transactional — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 *
 * Send one transactional SMS through a vendored adapter (twilio / amazon-sns).
 * Importing this module performs no I/O; configuration is validated at call time
 * with typed errors (serverless-safe). Transient vendor failures are retried;
 * every failure surfaces as an SmsError with secrets redacted.
 */
import { requireEnv } from "./internal/config";
import { SmsError } from "./internal/errors";
import { redactSecrets } from "./internal/redact";
import { withRetry } from "./internal/retry";
import type { SmsMessage } from "./internal/types";
import { normalizeMessage } from "./internal/validate";
import { adapter } from "../adapters/selected/adapter";

export { SmsError } from "./internal/errors";
export type { SmsErrorCode } from "./internal/errors";
export type { SmsMessage } from "./internal/types";

export interface SendResult {
  /** Vendor-assigned message id. */
  id: string;
  /** Adapter that performed the send. */
  adapter: string;
}

/** Send one transactional SMS through the vendored adapter. */
export async function send(message: SmsMessage): Promise<SendResult> {
  try {
    const normalized = normalizeMessage(message);

    const configured = requireEnv("SMS_ADAPTER");
    if (configured !== adapter.name) {
      throw new SmsError(
        "config",
        `SMS_ADAPTER is "${configured}" but the vendored adapter is "${adapter.name}" — ` +
          `re-vendor with: partkit upgrade sms.transactional --adapter=${configured}`,
        { retryable: false },
      );
    }

    const result = await withRetry(() => adapter.send(normalized));
    return { id: result.id, adapter: adapter.name };
  } catch (e) {
    if (e instanceof SmsError) {
      throw new SmsError(e.code, redactSecrets(e.message), {
        retryable: e.retryable,
        ...(e.status !== null && { status: e.status }),
      });
    }
    throw new SmsError("unknown", redactSecrets(e instanceof Error ? e.message : String(e)), {
      retryable: false,
    });
  }
}
