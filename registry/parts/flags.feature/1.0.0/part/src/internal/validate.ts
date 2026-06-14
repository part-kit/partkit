import { FlagError } from "./errors";
import { matchesType } from "./eval";
import type { ConditionOp, FlagDefinitionInput, FlagType } from "./types";

const MAX_KEY = 256;
const MAX_ATTR = 256;
const MAX_RULES = 100;
const MAX_CONDITIONS = 50;
const MAX_VARIANTS = 100;
const FLAG_TYPES: readonly FlagType[] = ["boolean", "number", "string", "json"];
const OPS: readonly ConditionOp[] = ["eq", "neq", "in", "contains", "gt", "lt"];

function invalid(detail: string): FlagError {
  return new FlagError("invalid_input", detail);
}

/**
 * Deep check that a value is real, lossless JSON — rejects BigInt, function,
 * symbol, undefined, non-finite numbers, and circular references. matchesType's
 * "json" branch only checks `!== undefined`, so these would otherwise pass
 * validation and then either throw a raw TypeError or be silently coerced to
 * null by JSON.stringify. Write-side only (rare); reads stay cheap.
 */
function isSerializableJson(value: unknown, seen: Set<unknown> = new Set()): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "boolean" || t === "string") return true;
  if (t === "number") return Number.isFinite(value);
  if (t === "object") {
    if (seen.has(value)) return false; // circular
    seen.add(value);
    if (Array.isArray(value)) return value.every((e) => isSerializableJson(e, seen));
    return Object.values(value as Record<string, unknown>).every((v) => isSerializableJson(v, seen));
  }
  return false; // bigint, function, symbol, undefined
}

/** A flag value must match the declared type — and for json, be lossless JSON. */
function okValue(value: unknown, type: FlagType): boolean {
  if (!matchesType(value, type)) return false;
  return type !== "json" || isSerializableJson(value);
}

export interface ValidatedFlagDef {
  key: string;
  type: FlagType;
  enabled: boolean;
  defaultJson: string;
  rulesJson: string;
  rolloutJson: string;
}

/** A flag key — required, bounded, non-empty (used by setFlag/getFlag/archiveFlag). */
export function validateKey(key: unknown): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw invalid("key is required and must be a non-empty string");
  }
  if (key.length > MAX_KEY) throw invalid(`key exceeds ${MAX_KEY} characters`);
  return key;
}

/** Validate a flag definition before any SQL: type-checks default/variant/rule values. */
export function validateFlagDef(input: FlagDefinitionInput): ValidatedFlagDef {
  if (input === null || typeof input !== "object") throw invalid("setFlag requires an input object");
  const key = validateKey(input.key);

  if (!FLAG_TYPES.includes(input.type)) {
    throw invalid(`type must be one of ${FLAG_TYPES.join(", ")}`);
  }
  if (typeof input.enabled !== "boolean") throw invalid("enabled must be a boolean");

  if (!okValue(input.default, input.type)) {
    throw invalid(`default value does not match the declared type "${input.type}" (or is not serializable JSON)`);
  }

  const rules = input.rules ?? [];
  if (!Array.isArray(rules)) throw invalid("rules must be an array");
  if (rules.length > MAX_RULES) throw invalid(`a flag may not have more than ${MAX_RULES} rules`);
  for (const rule of rules) {
    if (rule === null || typeof rule !== "object") throw invalid("each rule must be an object");
    if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) {
      throw invalid("each rule must have at least one condition");
    }
    if (rule.conditions.length > MAX_CONDITIONS) {
      throw invalid(`a rule may not have more than ${MAX_CONDITIONS} conditions`);
    }
    for (const c of rule.conditions) {
      if (c === null || typeof c !== "object") throw invalid("each condition must be an object");
      if (typeof c.attribute !== "string" || c.attribute.trim() === "" || c.attribute.length > MAX_ATTR) {
        throw invalid("each condition needs a non-empty attribute name");
      }
      if (!OPS.includes(c.op)) throw invalid(`condition op must be one of ${OPS.join(", ")}`);
    }
    if (!okValue(rule.variant, input.type)) {
      throw invalid(`a rule variant does not match the declared type "${input.type}" (or is not serializable JSON)`);
    }
  }

  const rollout = input.rollout ?? [];
  if (!Array.isArray(rollout)) throw invalid("rollout must be an array");
  if (rollout.length > MAX_VARIANTS) throw invalid(`rollout may not have more than ${MAX_VARIANTS} variants`);
  for (const v of rollout) {
    if (v === null || typeof v !== "object") throw invalid("each rollout variant must be an object");
    if (typeof v.weight !== "number" || !Number.isFinite(v.weight) || v.weight < 0) {
      throw invalid("each rollout variant needs a finite weight >= 0");
    }
    if (!okValue(v.value, input.type)) {
      throw invalid(`a rollout variant value does not match the declared type "${input.type}" (or is not serializable JSON)`);
    }
  }

  return {
    key,
    type: input.type,
    enabled: input.enabled,
    defaultJson: JSON.stringify(input.default),
    rulesJson: JSON.stringify(rules),
    rolloutJson: JSON.stringify(rollout),
  };
}
