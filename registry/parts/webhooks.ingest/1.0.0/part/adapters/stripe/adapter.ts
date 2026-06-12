/**
 * Stripe signature-scheme adapter. Zero npm dependencies: the wire format is
 * implemented directly from the vendor docs over node:crypto.
 * Scheme: https://docs.stripe.com/webhooks#verify-manually
 *
 *   Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
 *   signed content:   "<t>.<raw payload bytes>"
 *   key:              the whsec_… signing secret string, verbatim
 *
 * Multiple v1 elements may appear during key rotation; any one match
 * verifies. Signature is checked BEFORE the window, so a
 * timestamp_out_of_window error always refers to an authentic delivery.
 */
import {
  assertWithinWindow,
  hmacSha256,
  sha256Hex,
  timingSafeEqualBuffers,
} from "../../src/internal/crypto.js";
import { WebhookError } from "../../src/internal/errors.js";
import type {
  AdapterVerifyInput,
  AdapterVerifyOutput,
  WebhookAdapter,
} from "../../src/internal/types.js";

const HEADER = "stripe-signature";

function verifyStripe(input: AdapterVerifyInput): AdapterVerifyOutput {
  const header = input.headers[HEADER];
  if (header === undefined) {
    throw new WebhookError("missing_header", `missing ${HEADER} header`);
  }

  let timestampRaw: string | null = null;
  const candidates: Buffer[] = [];
  for (const element of header.split(",")) {
    const eq = element.indexOf("=");
    if (eq === -1) continue;
    const key = element.slice(0, eq).trim();
    const value = element.slice(eq + 1).trim();
    if (key === "t") timestampRaw = value;
    else if (key === "v1") candidates.push(Buffer.from(value, "hex"));
  }
  if (timestampRaw === null) {
    throw new WebhookError("missing_header", `${HEADER} header carries no t= timestamp element`);
  }
  if (candidates.length === 0) {
    throw new WebhookError("missing_header", `${HEADER} header carries no v1= signature element`);
  }

  // Sign with the RAW timestamp string — re-stringifying a parsed number
  // could alter bytes (leading zeros) and break authentic signatures.
  const expected = hmacSha256(
    input.secret,
    Buffer.concat([Buffer.from(`${timestampRaw}.`, "utf8"), input.payload]),
  );
  const matched = candidates.find((c) => timingSafeEqualBuffers(c, expected));
  if (matched === undefined) {
    throw new WebhookError(
      "invalid_signature",
      `${HEADER} did not verify over the raw payload bytes`,
    );
  }

  const timestamp = Number(timestampRaw);
  assertWithinWindow(timestamp, input.nowEpochSeconds, input.toleranceSeconds);

  // Stripe's scheme carries no delivery id in headers — derive a stable one
  // from the matched signature (types.ts documents this fallback).
  return {
    id: `whk_${sha256Hex(matched).slice(0, 24)}`,
    timestampEpochSeconds: timestamp,
    matchedSignature: matched,
  };
}

export const adapter: WebhookAdapter = { name: "stripe", verify: verifyStripe };
