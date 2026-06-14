import { FlagError } from "./errors";
import { matchesType, resolveFlag } from "./eval";
import { ARCHIVE_SQL, rowToFlag, SELECT_ACTIVE_SQL, SELECT_ALL_ACTIVE_SQL, SELECT_ONE_SQL, UPSERT_SQL } from "./sql";
import type {
  EvalContext,
  FlagDefinition,
  FlagDefinitionInput,
  FlagSet,
  FlagType,
  FlagValue,
  SqlExecutor,
} from "./types";
import { validateFlagDef, validateKey } from "./validate";

export function createFlagSet(db: SqlExecutor): FlagSet {
  // ── Evaluation: FAIL-SAFE. Wraps everything in try/catch and returns the
  //    caller's fallback (or omits the flag) on ANY error. Never throws.
  async function evaluate<T extends FlagValue>(
    key: string,
    context: EvalContext,
    fallback: T,
  ): Promise<T> {
    try {
      const res = await db.query(SELECT_ACTIVE_SQL, [key]);
      const row = res.rows[0];
      if (row === undefined) return fallback; // unknown or archived → caller's fallback
      const flag = rowToFlag(row);
      const resolved = resolveFlag(flag, context);
      // Type-check against BOTH the flag's declared type AND the caller's fallback
      // type. The generic <T> is the caller's contract: if a flag was retyped
      // (setFlag) while this caller's code still expects the old T, the resolved
      // value must not escape as the wrong T — fall back instead.
      const want: FlagType =
        typeof fallback === "boolean"
          ? "boolean"
          : typeof fallback === "number"
            ? "number"
            : typeof fallback === "string"
              ? "string"
              : "json";
      return matchesType(resolved, flag.type) && matchesType(resolved, want) ? (resolved as T) : fallback;
    } catch {
      return fallback; // storage / parse / anything → fail-safe
    }
  }

  async function evaluateAll(context: EvalContext): Promise<Record<string, FlagValue>> {
    const out: Record<string, FlagValue> = {};
    try {
      const res = await db.query(SELECT_ALL_ACTIVE_SQL, []);
      for (const row of res.rows) {
        try {
          const flag = rowToFlag(row);
          const resolved = resolveFlag(flag, context);
          if (matchesType(resolved, flag.type)) out[flag.key] = resolved; // else omit this flag
        } catch {
          /* omit a single malformed flag — never fail the whole bootstrap */
        }
      }
    } catch {
      /* storage error → return whatever resolved (empty), fail-safe */
    }
    return out;
  }

  // ── Management: STRICT. Validate, and surface a typed FlagError.
  async function setFlag(def: FlagDefinitionInput): Promise<void> {
    const v = validateFlagDef(def); // throws invalid_input before any SQL
    try {
      await db.query(UPSERT_SQL, [v.key, v.type, v.enabled, v.defaultJson, v.rulesJson, v.rolloutJson]);
    } catch (e) {
      throw new FlagError("storage", "failed to set flag", { cause: e });
    }
  }

  async function getFlag(key: string): Promise<FlagDefinition | null> {
    const k = validateKey(key);
    let res: { rows: Record<string, unknown>[] };
    try {
      res = await db.query(SELECT_ONE_SQL, [k]);
    } catch (e) {
      throw new FlagError("storage", "failed to get flag", { cause: e });
    }
    const row = res.rows[0];
    return row === undefined ? null : rowToFlag(row);
  }

  async function listFlags(): Promise<FlagDefinition[]> {
    let res: { rows: Record<string, unknown>[] };
    try {
      res = await db.query(SELECT_ALL_ACTIVE_SQL, []);
    } catch (e) {
      throw new FlagError("storage", "failed to list flags", { cause: e });
    }
    return res.rows.map(rowToFlag);
  }

  async function archiveFlag(key: string): Promise<void> {
    const k = validateKey(key);
    try {
      await db.query(ARCHIVE_SQL, [k]); // idempotent: 0 rows when already archived/unknown
    } catch (e) {
      throw new FlagError("storage", "failed to archive flag", { cause: e });
    }
  }

  return { evaluate, evaluateAll, setFlag, getFlag, listFlags, archiveFlag };
}
