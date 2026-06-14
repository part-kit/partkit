/**
 * Key material: generation, format, and the one-way hash used to store and
 * verify keys. Zero dependencies — everything is node:crypto.
 *
 * A key is `<prefix>_<secret>`:
 *   prefix = "ak" + base62(9 random bytes)   — public, indexed, shown in UIs
 *   secret = base62(24 random bytes)         — 192 bits of entropy, the secret
 *
 * Why a keyed hash (HMAC-SHA256) and NOT a password KDF (scrypt/argon2):
 * the secret is 192 bits of machine-generated randomness, so brute force is
 * already off the table — a slow KDF would add tens of milliseconds to the
 * verify HOT PATH (every API request) while buying no meaningful resistance.
 * We store HMAC-SHA256(key = per-key salt, message = secret): a salted, one-way,
 * fast digest, compared in constant time. (A KDF would be the right call only if
 * lower-entropy keys were ever introduced — see SPEC.md and RFC 0002 amendment.)
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BRAND = "ak";
const PREFIX_RANDOM_BYTES = 9; // 72 bits → ~12 base62 chars after the brand
const SECRET_BYTES = 24; // 192 bits
const SALT_BYTES = 16;
const HASH_BYTES = 32; // SHA-256 output width

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Encode bytes as base62 (big-endian), no padding. Deterministic, URL-safe. */
function base62(buf: Buffer): string {
  // Treat the buffer as one big-endian integer and repeatedly divmod by 62.
  const digits = Array.from(buf);
  let out = "";
  let hasMore = true;
  while (hasMore) {
    let remainder = 0;
    hasMore = false;
    for (let i = 0; i < digits.length; i += 1) {
      const acc = remainder * 256 + (digits[i] as number);
      const q = Math.floor(acc / 62);
      remainder = acc - q * 62;
      digits[i] = q;
      if (q > 0) hasMore = true;
    }
    out = BASE62[remainder] + out;
  }
  // Preserve leading-zero bytes as leading '0' chars so length is stable.
  for (const b of buf) {
    if (b === 0) out = `0${out}`;
    else break;
  }
  return out === "" ? "0" : out;
}

export interface KeyMaterial {
  prefix: string;
  secret: string;
  token: string;
}

/** Mint a fresh prefix + secret + full token. */
export function generateKey(): KeyMaterial {
  const prefix = BRAND + base62(randomBytes(PREFIX_RANDOM_BYTES));
  const secret = base62(randomBytes(SECRET_BYTES));
  return { prefix, secret, token: `${prefix}_${secret}` };
}

/** A fresh per-key salt (used as the HMAC key). */
export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/** HMAC-SHA256(key = salt, message = secret) → the stored one-way digest. */
export function hashSecret(secret: string, salt: Buffer): Buffer {
  return createHmac("sha256", salt).update(secret, "utf8").digest();
}

/** Parsed view of a presented key, or null if it is not well-formed. */
export interface ParsedKey {
  prefix: string;
  secret: string;
}

/**
 * Parse and shape-check a presented key WITHOUT touching the database. Returns
 * null for anything that is not a well-formed key — the caller maps that to
 * `malformed`. Shape (brand, separator, charset, minimum lengths) is public, so
 * distinguishing malformed from invalid leaks nothing about whether a key exists.
 */
export function parseKey(presented: unknown): ParsedKey | null {
  if (typeof presented !== "string") return null;
  const value = presented.trim();
  const sep = value.indexOf("_");
  if (sep <= BRAND.length) return null; // need a non-empty prefix after the brand
  const prefix = value.slice(0, sep);
  const secret = value.slice(sep + 1);
  if (!prefix.startsWith(BRAND)) return null;
  // A real prefix is ~14 chars and a real secret ~33; bound both so an oversized
  // value can never force HMAC work over megabytes of input (DoS amplification).
  if (prefix.length > 64) return null;
  if (secret.length < 16 || secret.length > 128) return null;
  if (!/^[0-9A-Za-z]+$/.test(prefix) || !/^[0-9A-Za-z]+$/.test(secret)) return null;
  return { prefix, secret };
}

/**
 * Constant-time equality over two digests. Returns false for length mismatch
 * (without leaking it through timing on the equal-length path), true only on a
 * byte-for-byte match. Never short-circuits on the first differing byte.
 */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// A fixed decoy salt + digest so that verifying an UNKNOWN prefix performs the
// same HMAC + constant-time compare as a known-prefix-wrong-secret attempt —
// the CPU work is uniform whether or not the prefix exists (contract invariant
// 3). The salt and digest are constants; they protect no real key.
const DECOY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);
const DECOY_DIGEST = hashSecret("decoy", DECOY_SALT);

/** Burn the same hash+compare work for an unknown prefix; result discarded. */
export function decoyCompare(secret: string): void {
  const d = hashSecret(secret, DECOY_SALT);
  digestsEqual(d, DECOY_DIGEST);
}

export { HASH_BYTES, SALT_BYTES };
