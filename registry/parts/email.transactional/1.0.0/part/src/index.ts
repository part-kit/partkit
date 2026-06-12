/**
 * email.transactional — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 */
import { adapter } from "../adapters/selected/adapter.js";
import { parseFromAddress, requireEnv } from "./internal/config.js";
import { EmailError } from "./internal/errors.js";
import { redactSecrets } from "./internal/redact.js";
import { withRetry } from "./internal/retry.js";
import type { EmailMessage } from "./internal/types.js";
import { normalizeMessage } from "./internal/validate.js";

export { EmailError } from "./internal/errors.js";
export type { EmailErrorCode } from "./internal/errors.js";
export type { EmailAddress, EmailMessage } from "./internal/types.js";

export interface SendResult {
  /** Vendor-assigned message id. */
  id: string;
  /** Adapter that performed the send. */
  adapter: string;
}

/**
 * Send one transactional email through the vendored adapter.
 *
 * Importing this module performs no I/O; configuration is validated here, at
 * call time, with typed errors (contract invariant 1 — serverless-safe).
 * Transient vendor failures are retried inside this call (invariant 4); every
 * failure surfaces as an EmailError with secrets redacted (invariants 5, 6).
 */
export async function send(message: EmailMessage): Promise<SendResult> {
  try {
    const normalized = normalizeMessage(message);

    const configured = requireEnv("EMAIL_ADAPTER");
    if (configured !== adapter.name) {
      throw new EmailError(
        "config",
        `EMAIL_ADAPTER is "${configured}" but the vendored adapter is "${adapter.name}" — ` +
          `re-vendor with: partkit upgrade email.transactional --adapter=${configured}`,
        { retryable: false },
      );
    }
    const from = parseFromAddress(requireEnv("EMAIL_FROM"));

    const result = await withRetry(() => adapter.send({ from, message: normalized }));
    return { id: result.id, adapter: adapter.name };
  } catch (e) {
    if (e instanceof EmailError) {
      throw new EmailError(e.code, redactSecrets(e.message), {
        retryable: e.retryable,
        ...(e.status !== null && { status: e.status }),
      });
    }
    throw new EmailError("unknown", redactSecrets(e instanceof Error ? e.message : String(e)), {
      retryable: false,
    });
  }
}
