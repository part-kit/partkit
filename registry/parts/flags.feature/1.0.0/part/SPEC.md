# flags.feature — design notes & threat model

`flags.feature` is the verified feature-flag primitive: typed flags with
first-match targeting rules and sticky percentage rollout, evaluated on a
**fail-safe** hot path. It composes with any auth part (the evaluation subject is
any opaque principal) with no `requires` edge. Zero-dependency (node:crypto for
bucketing), driver-free via the `SqlExecutor` seam; owns one table,
`feature_flags`, and reads no env.

## Fail-safe evaluation is the whole point

A flag check must never be the reason a request 500s. `evaluate`/`evaluateAll`
wrap everything in a single try/catch and return the caller's `fallback` (or omit
the flag) on **any** error — an unknown flag, a storage hiccup, a malformed
stored value, or a type mismatch. They never throw. The management operations
(`setFlag`/`getFlag`/`listFlags`/`archiveFlag`) are the strict mirror: they
validate and throw a typed `FlagError`.

Three dispositions are deliberately distinct:
- **disabled** (`enabled: false`) → the flag's **own configured `default`** — a
  kill switch returns the value the operator chose, not the caller's compiled-in
  default.
- **archived / unknown** → the **caller's `fallback`** — the part has no opinion,
  so the app's baseline governs. Archiving is the safe way to retire a flag.
- **error / type mismatch** → the **caller's `fallback`** (fail-safe).

## Sticky, uniform percentage rollout

Bucketing is `bucket = (uint32(sha256(len(key) + ":" + key + subjectId)) % 100000) / 100000`
∈ [0,1), then a walk of the variants by cumulative relative weight. (The key is
length-prefixed so the join is injective — a `:` inside a composite `subjectId`
can't collide two distinct flags.) Properties:

- **Sticky:** the output depends only on `(key, subjectId)` and a fixed hash — no
  time, no RNG — so a subject stays in the same bucket across requests, processes,
  and restarts (no flicker).
- **Uniform:** SHA-256 bytes are ~uniform, so a 10% rollout is ~10% of subjects;
  modulo bias is ≤0.0023% (2^32 dwarfs N).
- **Key-salted:** the flag `key` is hashed in, so two flags with the same split
  place a subject independently — you can run independent rollouts/experiments.
- **First 4 bytes only:** a JS number has 53 bits of mantissa; consuming >53 bits
  (an 8-byte slice) silently loses precision and breaks uniformity (a real
  LaunchDarkly SDK bug). The uint32 slice sidesteps it.

Without a `subjectId`, bucketing can't be sticky, so rollout is skipped and the
flag falls through to its `default` (never random-assigned).

## Type safety

Every flag declares a `type` (`boolean`/`number`/`string`/`json`). On the write
side, `setFlag` rejects a `default`, rule `variant`, or rollout value whose type
doesn't match (`number` also rejects NaN/Infinity). On the read side, the resolved
value is type-checked before it is returned — so a value that somehow drifted to
the wrong type in storage can never escape as the wrong type; it fails safe to the
fallback. A boolean flag can never be read as a string.

## <a id="threat-model"></a>Threat model

| Threat | Mitigation |
|---|---|
| **A flag outage takes the app down** | `evaluate`/`evaluateAll` are fail-safe — any error returns the caller's fallback; they never throw. A DB hiccup degrades to fallbacks, not a 500. |
| **Inconsistent rollout (a user flickers in/out)** | Deterministic, stable bucketing by `sha256(key + subjectId)` — same subject always lands the same bucket; no RNG, no per-request drift. |
| **Correlated cohorts across flags** | The flag key salts the hash, so a subject's placement is independent per flag (measured ≈ independent, not correlated). |
| **A wrong-typed value ships a bug** | Two-sided type-checking: `setFlag` rejects mismatched values; `evaluate` re-checks the resolved value and fails safe. |
| **A missing attribute silently flips a flag** | A missing attribute never matches any operator — including `neq` — so an attribute-less context falls through to rollout/default rather than matching a negation rule. |
| **SQL injection via key/attribute/value** | Constant statements, positional parameters only; every statement touches only `feature_flags`. jsonb values round-trip as data. |
| **Secret/raw-error leakage** | The part holds no secret; storage errors carry the raw driver error only on `.cause` with a generic `.message`. |

### Out of scope (v1, see RFC 0006 §5)

Change auditing (compose with `audit.log`), scheduled/temporary flags, a client
streaming endpoint, and `data_ownership.reads` for `admin.crud` are additive
futures. v1 is stateless evaluation: one indexed lookup per `evaluate`, one scan
per `evaluateAll`, no per-evaluation write.
