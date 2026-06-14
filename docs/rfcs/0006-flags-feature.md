# RFC 0006 — `flags.feature` capability

**Status:** accepted 2026-06-14 (chief-architect session; capability already in the docs/02 namespace, this RFC specifies its interface)
**Adds capability:** `flags.feature@1`
**Unblocks:** the `marketplace` App Pack (with `search.fulltext`); useful across every skeleton (gated rollouts, kill switches)
**Composes with:** `auth.session` / `auth.tenancy` / `auth.apikey` (the evaluation subject is any opaque principal); no `requires` edge
**Author:** chief-architect session, 2026-06-14

## 1. Problem

Every product needs to turn features on for some users and not others —
percentage rollouts, a kill switch for a flaky feature, a beta cohort, per-plan
gating. Hand-rolled flags are where this goes wrong: the check throws when the
flag store is briefly unavailable (so a flag outage takes the whole app down),
the "10% rollout" isn't sticky (a user flickers in and out between requests),
the bucketing isn't uniform, and there's no typed contract so a boolean flag
read as a string ships a bug.

`flags.feature` is the verified flag primitive: define typed flags with targeting
rules and sticky percentage rollout, and evaluate them on a **fail-safe** hot
path that returns the caller's fallback (never throws) when anything is wrong.

## 2. Interface (`flags.feature@1`)

```ts
flags(db: SqlExecutor): FlagSet

interface FlagSet {
  // Evaluation — FAIL-SAFE. Returns the resolved value, or `fallback` on an
  // unknown flag / type mismatch / storage error. NEVER throws on this path.
  evaluate<T extends FlagValue>(key: string, context: EvalContext, fallback: T): Promise<T>;
  // Resolve every active flag for a context in one query (client bootstrap).
  evaluateAll(context: EvalContext): Promise<Record<string, FlagValue>>;

  // Management — typed FlagError on bad input / storage failure.
  setFlag(def: FlagDefinitionInput): Promise<void>;     // upsert by key
  getFlag(key: string): Promise<FlagDefinition | null>;
  listFlags(): Promise<FlagDefinition[]>;
  archiveFlag(key: string): Promise<void>;              // soft-disable; evaluate falls back
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type FlagValue = boolean | number | string | Json;
type FlagType = "boolean" | "number" | "string" | "json";

interface EvalContext {
  subjectId?: string;                                   // stable id for sticky rollout
  attributes?: Record<string, string | number | boolean>; // for rule matching
}

interface Rule { attribute: string; op: "eq" | "neq" | "in" | "contains" | "gt" | "lt"; value: Json; variant: FlagValue }
interface Variant { value: FlagValue; weight: number }  // weights are relative

interface FlagDefinitionInput {
  key: string;
  type: FlagType;
  enabled: boolean;
  default: FlagValue;                                    // value when on but no rule/rollout decides
  rules?: Rule[];                                        // first-match-wins, conditions AND-ed
  rollout?: Variant[];                                   // sticky percentage split by subjectId
}

class FlagError extends Error { code: "invalid_input" | "storage" }  // evaluate never throws
```

Owns the `feature_flags` table (forward-only migrations, `partkit migrate`).
Zero npm dependencies — deterministic bucketing is `node:crypto`.

## 3. Invariants (each maps to ≥1 conformance test)

1. Importing performs no I/O and never throws; management ops validate input with a typed `FlagError`; **`evaluate`/`evaluateAll` are fail-safe** — an unknown flag, a stored value whose type ≠ the flag's declared type, or a storage error returns the caller's `fallback` (or omits the flag), and never throws.
2. **Evaluation is deterministic and sticky:** the same `(key, subjectId)` resolves to the same variant for a given flag config; percentage rollout buckets **uniformly** by a stable hash of `key + subjectId`, so a user does not flicker between requests and a 10% rollout is ~10% of subjects.
3. Targeting `rules` are **first-match-wins** with all conditions AND-ed against `context.attributes`; a non-matching (or attribute-less) context falls through to rollout, then to the flag's `default`.
4. A **disabled** flag resolves to its configured `default`; an **archived or unknown** flag resolves to the caller's `fallback`.
5. Values are **type-checked** against the flag's declared `type` — a value of the wrong type never escapes as the wrong type (it fails safe to `fallback`); `setFlag` rejects a `default`/variant/rule value that doesn't match `type`.
6. The part operates solely through the `SqlExecutor` seam (no driver import); every statement targets only `feature_flags`, and all inputs are parameterized.

## 4. Implementation notes for the part author

- **Sticky bucketing:** `bucket = (uint32(sha256(key + ":" + subjectId)) % 10_000) / 10_000` ∈ [0,1); walk `rollout` variants by cumulative normalized weight. Uniform + stable + zero-dep. With no `subjectId`, rollout cannot be sticky → fall through to `default` (document it). Salt the hash with the flag `key` so two flags with the same rollout don't correlate.
- **Fail-safe is the point:** wrap the whole evaluate in try/catch and return `fallback` on ANY error (storage, parse, type) — a flag system must never be the reason a request 500s. Management ops are the opposite: typed, strict, throw on bad input.
- DB-backed → `audit.log` conformance pattern: rollout uniformity/stickiness, rule matching, type-safety, and fail-safe behavior against real Postgres gated on `PARTKIT_TEST_DATABASE_URL`; validation, type-checking, and the bucketing-uniformity math run DB-free.
- One table, definition-only (`feature_flags`): `key` PK, `type`, `enabled`, `default jsonb`, `rules jsonb`, `rollout jsonb`, `archived_at`, timestamps. Evaluation is a single indexed lookup by key (or one scan for `evaluateAll`); there is no per-evaluation write (stateless evaluation).

## 5. Roadmap (not v1)

- Audit of flag changes (compose with `audit.log`).
- Scheduled flag changes / temporary flags with an expiry.
- A streaming/bootstrap endpoint for client SDKs.
- `data_ownership.reads` so `admin.crud` can administer flags.
