/**
 * Pure flag-resolution logic — no I/O, no throw. Zero-dependency: the only
 * primitive is node:crypto for deterministic sticky bucketing.
 */
import { createHash } from "node:crypto";
import type { Condition, EvalContext, FlagDefinition, FlagType, FlagValue, Rule, Variant } from "./types";

const BUCKET_N = 100_000; // 0.001% resolution

/**
 * Deterministic bucket in [0, 1) for (flag key, subject). Stable across
 * processes/time and salted by the flag KEY so two flags don't correlate. Uses
 * the FIRST 4 BYTES of sha256 as a uint32 — NOT 8 bytes: a JS number has 53
 * bits of mantissa, and consuming >53 bits silently loses precision and breaks
 * uniformity (the LaunchDarkly node-SDK bug). u32 % 100000 has negligible
 * modulo bias (≤0.0023%) because 2^32 dwarfs N.
 */
export function bucket(key: string, subjectId: string): number {
  // Length-prefix the key so the (key, subjectId) join is INJECTIVE — a raw
  // `${key}:${subjectId}` collides when either field contains ':' (e.g. a
  // composite subjectId "org:1:user:2"), which would correlate distinct flags.
  const u32 = createHash("sha256").update(`${key.length}:${key}${subjectId}`).digest().readUInt32BE(0);
  return (u32 % BUCKET_N) / BUCKET_N;
}

/** Pick a variant by cumulative relative weight; bucket b ∈ [0,1). */
export function pickVariant(variants: Variant[], b: number): FlagValue | undefined {
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  let total = 0;
  for (const v of variants) total += typeof v.weight === "number" && v.weight > 0 ? v.weight : 0;
  if (total <= 0) return undefined;
  const target = b * total;
  let cumulative = 0;
  for (const v of variants) {
    cumulative += typeof v.weight === "number" && v.weight > 0 ? v.weight : 0;
    if (target < cumulative) return v.value;
  }
  return variants[variants.length - 1]!.value; // float-rounding guard
}

/** Does a value match the flag's declared type? (number rejects NaN/Infinity.) */
export function matchesType(value: unknown, type: FlagType): boolean {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "json":
      return value !== undefined;
    default:
      return false;
  }
}

type AttrValue = string | number | boolean;

/** Lenient equality: numeric coercion if either side is a number, else boolean/string. */
function looseEq(lhs: AttrValue, rhs: Json): boolean {
  if (typeof lhs === "number" || typeof rhs === "number") {
    const a = Number(lhs);
    const b = Number(rhs);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  if (typeof lhs === "boolean" || typeof rhs === "boolean") return (lhs as unknown) === (rhs as unknown);
  return String(lhs) === String(rhs);
}

type Json = FlagValue;

/** Match one condition against the context attributes. Missing attribute → no match (incl. neq). */
function matchCondition(attributes: Record<string, AttrValue>, c: Condition): boolean {
  // OWN-property read only: a bare `attributes[c.attribute]` would read inherited
  // members (__proto__, constructor, toString…) off Object.prototype, which are
  // never undefined — so a rule on such a key would bypass the missing-attribute
  // guard and (via neq) match every context. Object.hasOwn closes that.
  const lhs = Object.hasOwn(attributes, c.attribute) ? attributes[c.attribute] : undefined;
  if (lhs === undefined) return false; // a missing attribute never matches — even neq
  const rhs = c.value;
  switch (c.op) {
    case "eq":
      return looseEq(lhs, rhs);
    case "neq":
      return !looseEq(lhs, rhs);
    case "in":
      return Array.isArray(rhs) && rhs.some((e) => looseEq(lhs, e));
    case "contains":
      return typeof lhs === "string" && typeof rhs === "string" && lhs.includes(rhs);
    case "gt": {
      const a = Number(lhs);
      const b = Number(rhs);
      return Number.isFinite(a) && Number.isFinite(b) && a > b;
    }
    case "lt": {
      const a = Number(lhs);
      const b = Number(rhs);
      return Number.isFinite(a) && Number.isFinite(b) && a < b;
    }
    default:
      return false;
  }
}

/** A rule matches when ALL its conditions match. */
function matchRule(attributes: Record<string, AttrValue>, rule: Rule): boolean {
  return (
    Array.isArray(rule.conditions) &&
    rule.conditions.length > 0 &&
    rule.conditions.every((c) => matchCondition(attributes, c))
  );
}

/**
 * Resolve a flag to a value (NOT yet type-checked — the caller type-checks once,
 * failing safe to the fallback on mismatch). Order: disabled → default; else
 * first-match rule → rollout (only if a subjectId is present) → default.
 */
export function resolveFlag(flag: FlagDefinition, context: EvalContext): FlagValue {
  if (!flag.enabled) return flag.default;
  const attributes = context.attributes ?? {};
  for (const rule of flag.rules) {
    if (matchRule(attributes, rule)) return rule.variant;
  }
  if (context.subjectId !== undefined && context.subjectId !== "" && flag.rollout.length > 0) {
    const chosen = pickVariant(flag.rollout, bucket(flag.key, context.subjectId));
    if (chosen !== undefined) return chosen;
  }
  return flag.default;
}
