import { StorageError } from "./errors.js";

const MAX_KEY_BYTES = 1024; // S3 object-key limit
const MIN_EXPIRY = 1;
const MAX_EXPIRY = 604_800; // 7 days — the SigV4 query-auth maximum
export const DEFAULT_EXPIRY = 900;

/** True if the string contains an ASCII control character (0x00–0x1F or 0x7F). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/**
 * Validate the object key before signing: an empty, over-long, leading-slash,
 * or control-character key is rejected with zero output (contract invariant 5).
 * Spaces, Unicode, and S3-special characters are allowed — they are encoded by
 * the signer, not rejected.
 */
export function validateKey(key: string): void {
  if (typeof key !== "string" || key === "") {
    throw new StorageError("invalid_key", "key is required and must be a non-empty string");
  }
  if (key.startsWith("/")) {
    throw new StorageError("invalid_key", "key must not start with '/' (it is not a URL path)");
  }
  if (hasControlChar(key)) {
    throw new StorageError("invalid_key", "key must not contain control characters");
  }
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new StorageError("invalid_key", `key exceeds ${MAX_KEY_BYTES} bytes`);
  }
}

/**
 * Resolve and bound the expiry (contract invariant 6): default 900s, and an
 * out-of-range or non-integer value fails fast with a typed error.
 */
export function resolveExpiry(expiresInSeconds: number | undefined): number {
  if (expiresInSeconds === undefined) return DEFAULT_EXPIRY;
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < MIN_EXPIRY ||
    expiresInSeconds > MAX_EXPIRY
  ) {
    throw new StorageError(
      "invalid_options",
      `expiresInSeconds must be an integer in ${MIN_EXPIRY}..${MAX_EXPIRY}, got ${String(expiresInSeconds)}`,
    );
  }
  return expiresInSeconds;
}
