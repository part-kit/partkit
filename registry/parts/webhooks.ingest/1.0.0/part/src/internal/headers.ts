import type { NormalizedHeaders, WebhookHeaders } from "./types.js";

/**
 * Accept both Web-standard Headers (App Router) and plain records (node http,
 * test code); adapters always see lowercased single-valued keys. For
 * multi-valued records the first value wins — signature schemes sign exactly
 * one value per header, so duplicates are at best noise.
 */
export function normalizeHeaders(headers: WebhookHeaders): NormalizedHeaders {
  const out: NormalizedHeaders = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower in out) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) out[lower] = first;
  }
  return out;
}
