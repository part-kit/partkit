/**
 * The driver-free database seam — the same minimal `node-postgres` Client/Pool
 * shape `partkit migrate` uses. The app wires its own `pg` Pool to this; the
 * part imports no driver (contract invariant 6). Wiring example: seams.md §2.
 */
export interface SqlExecutor {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type FlagType = "boolean" | "number" | "string" | "json";
export type FlagValue = boolean | number | string | Json;

/** Evaluation input — subjectId enables sticky rollout, attributes drive rules. */
export interface EvalContext {
  /** A stable id for the principal (user/org). Required for sticky percentage rollout. */
  subjectId?: string;
  /** Arbitrary attributes matched by targeting rules. */
  attributes?: Record<string, string | number | boolean>;
}

export type ConditionOp = "eq" | "neq" | "in" | "contains" | "gt" | "lt";

/** One targeting condition: compare context.attributes[attribute] against value. */
export interface Condition {
  attribute: string;
  op: ConditionOp;
  value: Json;
}

/** A targeting rule: matches when ALL conditions hold; first matching rule wins. */
export interface Rule {
  conditions: Condition[];
  variant: FlagValue;
}

/** A weighted variant for sticky percentage rollout. Weights are relative. */
export interface Variant {
  value: FlagValue;
  weight: number;
}

/** What setFlag accepts (upsert). */
export interface FlagDefinitionInput {
  key: string;
  type: FlagType;
  enabled: boolean;
  /** The value when the flag is ON but no rule/rollout decides. */
  default: FlagValue;
  rules?: Rule[];
  rollout?: Variant[];
}

/** A stored flag definition (getFlag/listFlags). */
export interface FlagDefinition {
  key: string;
  type: FlagType;
  enabled: boolean;
  default: FlagValue;
  rules: Rule[];
  rollout: Variant[];
  /** Set once archived (soft-delete); evaluation then uses the caller's fallback. */
  archivedAt: Date | null;
}

export interface FlagSet {
  /**
   * FAIL-SAFE evaluation: returns the resolved value, or `fallback` on an unknown
   * flag / type mismatch / storage error. Never throws on this path.
   */
  evaluate<T extends FlagValue>(key: string, context: EvalContext, fallback: T): Promise<T>;
  /** Resolve every active flag for a context in one query (client bootstrap). */
  evaluateAll(context: EvalContext): Promise<Record<string, FlagValue>>;
  /** Upsert a flag definition by key (un-archives if it was archived). */
  setFlag(def: FlagDefinitionInput): Promise<void>;
  /** Fetch one flag (returns an archived flag too, for management visibility). */
  getFlag(key: string): Promise<FlagDefinition | null>;
  /** List active (non-archived) flags. */
  listFlags(): Promise<FlagDefinition[]>;
  /** Soft-disable a flag; evaluation falls back afterwards. */
  archiveFlag(key: string): Promise<void>;
}
