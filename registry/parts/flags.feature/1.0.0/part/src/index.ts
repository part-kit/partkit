/**
 * flags.feature — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 *
 * Typed feature flags with targeting rules and sticky percentage rollout, on a
 * FAIL-SAFE evaluation hot path: a flag outage never throws — it returns your
 * fallback. Bind it to a database connection (the SqlExecutor seam); constructing
 * it performs no I/O.
 */
import { createFlagSet } from "./internal/flags";
import type { FlagSet, SqlExecutor } from "./internal/types";

export { FlagError } from "./internal/errors";
export type { FlagErrorCode } from "./internal/errors";
export type {
  Condition,
  ConditionOp,
  EvalContext,
  FlagDefinition,
  FlagDefinitionInput,
  FlagSet,
  FlagType,
  FlagValue,
  Json,
  Rule,
  SqlExecutor,
  Variant,
} from "./internal/types";

/**
 * Bind the flag set to a database connection (the SqlExecutor seam).
 * Constructing it performs no I/O and never throws (contract invariant 1).
 *
 *   const ff = flags(db);
 *   if (await ff.evaluate("new-checkout", { subjectId: user.id }, false)) { … }
 *   await ff.setFlag({ key: "new-checkout", type: "boolean", enabled: true,
 *                      default: false, rollout: [{ value: true, weight: 10 }, { value: false, weight: 90 }] });
 */
export function flags(db: SqlExecutor): FlagSet {
  return createFlagSet(db);
}
