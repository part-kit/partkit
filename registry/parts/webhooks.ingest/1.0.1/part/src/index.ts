/**
 * webhooks.ingest — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 */
import { adapter } from "../adapters/selected/adapter";
import { requireEnv, toleranceSeconds } from "./internal/config";
import { sha256Hex } from "./internal/crypto";
import { WebhookError } from "./internal/errors";
import { normalizeHeaders } from "./internal/headers";
import { redactSecrets } from "./internal/redact";
import { assertNotReplayed } from "./internal/replay";
import type { Unsubscribe, VerifiedWebhook, WebhookRequest } from "./internal/types";

export { WebhookError } from "./internal/errors";
export type { WebhookErrorCode } from "./internal/errors";
export type {
  Unsubscribe,
  VerifiedWebhook,
  WebhookHeaders,
  WebhookRequest,
} from "./internal/types";

/**
 * Verify one inbound webhook delivery: HMAC signature over the exact raw
 * payload bytes (timing-safe), signed-timestamp window, per-instance replay
 * defense (contract invariants 2–5).
 *
 * Importing this module performs no I/O; configuration is validated here, at
 * call time, with typed errors (invariant 1 — serverless-safe). Every failure
 * surfaces as a WebhookError carrying the HTTP status your route should
 * answer with, and secrets are redacted from every message (invariant 6).
 */
export async function verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook> {
  try {
    const configured = requireEnv("WEBHOOK_ADAPTER");
    if (configured !== adapter.name) {
      throw new WebhookError(
        "config",
        `WEBHOOK_ADAPTER is "${configured}" but the vendored adapter is "${adapter.name}" — ` +
          `re-vendor with: partkit upgrade webhooks.ingest --adapter=${configured}`,
      );
    }
    const secret = requireEnv("WEBHOOK_SECRET");
    const tolerance = toleranceSeconds();
    const payload =
      typeof request.payload === "string"
        ? Buffer.from(request.payload, "utf8")
        : Buffer.from(request.payload);
    const nowEpochSeconds = Math.floor(Date.now() / 1000);

    const verified = adapter.verify({
      payload,
      headers: normalizeHeaders(request.headers),
      secret,
      nowEpochSeconds,
      toleranceSeconds: tolerance,
    });
    // Replay key = the verified signature: identical for byte-identical
    // replays, fresh on legitimate redeliveries (vendors re-sign retries).
    assertNotReplayed(
      `${adapter.name}:${sha256Hex(verified.matchedSignature)}`,
      nowEpochSeconds,
      tolerance,
    );

    return {
      id: verified.id,
      timestamp: new Date(verified.timestampEpochSeconds * 1000),
      payload: payload.toString("utf8"),
      adapter: adapter.name,
    };
  } catch (e) {
    if (e instanceof WebhookError) {
      throw new WebhookError(e.code, redactSecrets(e.message));
    }
    throw new WebhookError("unknown", redactSecrets(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * Module-scope registration, re-evaluated per cold start — the only
 * sanctioned subscription form under serverless runtimes (docs/02 §2).
 * Register in the same module that mounts webhookHandler (seams.md §3).
 */
const handlers = new Set<(event: VerifiedWebhook) => void | Promise<void>>();

export function onWebhook(
  handler: (event: VerifiedWebhook) => void | Promise<void>,
): Unsubscribe {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

function jsonResponse(status: number, error?: string): Response {
  return new Response(JSON.stringify(error === undefined ? { received: true } : { error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The route the app mounts (contract http_routes): verifies the delivery,
 * dispatches to every onWebhook handler IN ORDER, and acknowledges 2xx only
 * after all of them completed (invariant 7). Verification failures answer a
 * generic 400 — no detail leaks to unauthenticated callers; configuration
 * problems and handler failures answer 500 so the vendor redelivers.
 */
export async function webhookHandler(request: Request): Promise<Response> {
  let event: VerifiedWebhook;
  try {
    if (handlers.size === 0) {
      throw new WebhookError(
        "config",
        "no webhook handlers registered — call onWebhook() at module scope " +
          "in the file that mounts webhookHandler (seams.md §3)",
      );
    }
    const payload = Buffer.from(await request.arrayBuffer());
    event = await verifyWebhook({ payload, headers: request.headers });
  } catch (e) {
    const status = e instanceof WebhookError ? e.status : 500;
    return jsonResponse(
      status,
      status >= 500 ? "webhook ingest misconfigured" : "webhook verification failed",
    );
  }
  try {
    for (const handler of handlers) await handler(event);
  } catch {
    return jsonResponse(500, "webhook handler failed");
  }
  return jsonResponse(200);
}
