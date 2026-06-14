import type { FlagDefinition, FlagType, FlagValue, Json, Rule, Variant } from "./types";

/**
 * Every statement is a CONSTANT string with positional placeholders — no input
 * is concatenated into SQL (contract invariant 6). Each references only the
 * part-owned `feature_flags` table. NOTE: `default` is a SQL reserved word, so it
 * is quoted as `"default"` in every statement.
 */

/** Upsert by key. Re-setting a flag un-archives it (archived_at = NULL). */
export const UPSERT_SQL = `INSERT INTO feature_flags
  (key, type, enabled, "default", rules, rollout, updated_at)
VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, now())
ON CONFLICT (key) DO UPDATE SET
  type        = EXCLUDED.type,
  enabled     = EXCLUDED.enabled,
  "default"   = EXCLUDED."default",
  rules       = EXCLUDED.rules,
  rollout     = EXCLUDED.rollout,
  archived_at = NULL,
  updated_at  = now()`;

/** evaluate's internal lookup — active flags only (archived/unknown → fallback). */
export const SELECT_ACTIVE_SQL = `SELECT key, type, enabled, "default", rules, rollout, archived_at
FROM feature_flags WHERE key = $1 AND archived_at IS NULL`;

/** getFlag — returns an archived flag too, for management visibility. */
export const SELECT_ONE_SQL = `SELECT key, type, enabled, "default", rules, rollout, archived_at
FROM feature_flags WHERE key = $1`;

/** evaluateAll / listFlags — active flags, deterministic order. */
export const SELECT_ALL_ACTIVE_SQL = `SELECT key, type, enabled, "default", rules, rollout, archived_at
FROM feature_flags WHERE archived_at IS NULL ORDER BY key`;

/** Soft-disable. Idempotent (already-archived → no row). */
export const ARCHIVE_SQL = `UPDATE feature_flags
  SET archived_at = now(), updated_at = now()
WHERE key = $1 AND archived_at IS NULL
RETURNING key`;

/** jsonb columns arrive from node-postgres ALREADY PARSED — a jsonb string value
 *  comes back as a JS string, a jsonb object/array as a JS object/array, etc. So
 *  return the value as-is; do NOT JSON.parse it (that would corrupt a string
 *  value like "standard" → a parse error → null). */
export function parseJson(v: unknown): Json {
  return (v ?? null) as Json;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(String(v));
}

export function rowToFlag(row: Record<string, unknown>): FlagDefinition {
  return {
    key: String(row["key"]),
    type: String(row["type"]) as FlagType,
    enabled: row["enabled"] === true,
    default: parseJson(row["default"]) as FlagValue,
    rules: asArray<Rule>(parseJson(row["rules"])),
    rollout: asArray<Variant>(parseJson(row["rollout"])),
    archivedAt: asDate(row["archived_at"]),
  };
}
