/**
 * Standard Webhooks signature-scheme adapter — the Svix wire format used by
 * Resend, Clerk, and any vendor following the open spec. Zero npm
 * dependencies: implemented directly from the spec over node:crypto.
 * Spec: https://www.standardwebhooks.com/
 *
 *   webhook-id / webhook-timestamp / webhook-signature   (svix-* aliases accepted)
 *   signature header: space-separated list of "v1,<base64 HMAC-SHA256>"
 *   signed content:   "<id>.<timestamp>.<raw payload bytes>"
 *   key:              base64-decoded secret, whsec_ prefix stripped
 *
 * Any one listed v1 signature matching verifies (key rotation). Signature is
 * checked BEFORE the window, so a timestamp_out_of_window error always
 * refers to an authentic delivery.
 */
import {
  assertWithinWindow,
  hmacSha256,
  timingSafeEqualBuffers,
} from "../../src/internal/crypto";
import { WebhookError } from "../../src/internal/errors";
import type {
  AdapterVerifyInput,
  AdapterVerifyOutput,
  WebhookAdapter,
} from "../../src/internal/types";

function requireHeader(
  headers: AdapterVerifyInput["headers"],
  name: string,
): string {
  const value = headers[name] ?? headers[name.replace("webhook-", "svix-")];
  if (value === undefined) {
    throw new WebhookError(
      "missing_header",
      `missing ${name} header (svix-* alias accepted)`,
    );
  }
  return value;
}

function verifyStandardWebhooks(input: AdapterVerifyInput): AdapterVerifyOutput {
  const id = requireHeader(input.headers, "webhook-id");
  const timestampRaw = requireHeader(input.headers, "webhook-timestamp");
  const signatureHeader = requireHeader(input.headers, "webhook-signature");

  const key = Buffer.from(input.secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) {
    throw new WebhookError(
      "config",
      "WEBHOOK_SECRET is not a valid Standard Webhooks secret — expected whsec_<base64>",
    );
  }

  const candidates: Buffer[] = [];
  for (const entry of signatureHeader.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma === -1) continue;
    if (entry.slice(0, comma) !== "v1") continue;
    candidates.push(Buffer.from(entry.slice(comma + 1), "base64"));
  }
  if (candidates.length === 0) {
    throw new WebhookError(
      "missing_header",
      "webhook-signature header carries no v1 signature entry",
    );
  }

  const expected = hmacSha256(
    key,
    Buffer.concat([Buffer.from(`${id}.${timestampRaw}.`, "utf8"), input.payload]),
  );
  const matched = candidates.find((c) => timingSafeEqualBuffers(c, expected));
  if (matched === undefined) {
    throw new WebhookError(
      "invalid_signature",
      "webhook-signature did not verify over the raw payload bytes",
    );
  }

  const timestamp = Number(timestampRaw);
  assertWithinWindow(timestamp, input.nowEpochSeconds, input.toleranceSeconds);

  return { id, timestampEpochSeconds: timestamp, matchedSignature: matched };
}

export const adapter: WebhookAdapter = {
  name: "standardwebhooks",
  verify: verifyStandardWebhooks,
};
