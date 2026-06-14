import type { ApiKeyContext, ApiKeyInfo } from "./types";

/**
 * Every statement is a CONSTANT string with positional placeholders — no input
 * is ever concatenated into SQL, so metacharacters in ownerId/name/scopes are
 * data, never code (contract invariant 8). Each references only the part-owned
 * `auth_apikey_keys` table. The `prefix` is both the verify-time lookup key
 * (indexed, unique) and the management id returned to the app.
 */

/** Mint a key. key_hash and salt are bytea; scopes is text[]. */
export const INSERT_SQL = `INSERT INTO auth_apikey_keys
  (prefix, key_hash, salt, owner_id, name, scopes, expires_at)
VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
RETURNING prefix, owner_id, name, scopes, created_at, last_used_at, expires_at, revoked_at`;

/** The single indexed lookup the verify hot path performs (contract invariant 3). */
export const SELECT_BY_PREFIX_SQL = `SELECT
  prefix, key_hash, salt, owner_id, name, scopes,
  created_at, last_used_at, expires_at, revoked_at, rotated_at, grace_until
FROM auth_apikey_keys WHERE prefix = $1`;

/** Throttled last-seen write — issued at most once per interval (JS-gated). */
export const TOUCH_SQL = `UPDATE auth_apikey_keys SET last_used_at = now() WHERE prefix = $1`;

/** Idempotent revoke: keeps the original revoked_at if already revoked. */
export const REVOKE_SQL = `UPDATE auth_apikey_keys
  SET revoked_at = COALESCE(revoked_at, now())
WHERE prefix = $1
RETURNING prefix`;

/** Mark the old key as rotated and set its bounded grace window. */
export const ROTATE_OLD_SQL = `UPDATE auth_apikey_keys
  SET rotated_at = now(), grace_until = now() + make_interval(secs => $2::int)
WHERE prefix = $1
RETURNING prefix`;

/** listKeys: management metadata only — never key_hash or salt (invariant 2). */
export const SELECT_BY_OWNER_SQL = `SELECT
  prefix, name, scopes, created_at, last_used_at, expires_at, revoked_at
FROM auth_apikey_keys WHERE owner_id = $1 ORDER BY created_at DESC`;

/** The raw row the verify path reads — includes secret material (hash, salt). */
export interface VerifyRow {
  prefix: string;
  keyHash: Buffer;
  salt: Buffer;
  ownerId: string;
  name: string | null;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  rotatedAt: Date | null;
  graceUntil: Date | null;
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(String(v));
}

function asBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  // node-postgres returns bytea as Buffer; this guard keeps types honest.
  return Buffer.from(v as Uint8Array);
}

function asScopes(v: unknown): string[] {
  return Array.isArray(v) ? v.map((s) => String(s)) : [];
}

export function rowToVerifyRow(row: Record<string, unknown>): VerifyRow {
  return {
    prefix: String(row["prefix"]),
    keyHash: asBuffer(row["key_hash"]),
    salt: asBuffer(row["salt"]),
    ownerId: String(row["owner_id"]),
    name: row["name"] === null || row["name"] === undefined ? null : String(row["name"]),
    scopes: asScopes(row["scopes"]),
    lastUsedAt: asDate(row["last_used_at"]),
    expiresAt: asDate(row["expires_at"]),
    revokedAt: asDate(row["revoked_at"]),
    rotatedAt: asDate(row["rotated_at"]),
    graceUntil: asDate(row["grace_until"]),
  };
}

export function rowToContext(row: VerifyRow): ApiKeyContext {
  return {
    id: row.prefix,
    ownerId: row.ownerId,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt,
  };
}

export function rowToInfo(row: Record<string, unknown>): ApiKeyInfo {
  return {
    id: String(row["prefix"]),
    prefix: String(row["prefix"]),
    name: row["name"] === null || row["name"] === undefined ? null : String(row["name"]),
    scopes: asScopes(row["scopes"]),
    createdAt: asDate(row["created_at"]) ?? new Date(0),
    lastUsedAt: asDate(row["last_used_at"]),
    expiresAt: asDate(row["expires_at"]),
    revokedAt: asDate(row["revoked_at"]),
  };
}
