# Seams — flags.feature

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested interior;
edits void the attestation and fail CI).

## 1. The connection seam + one migration

This part owns one Postgres table, `feature_flags`, reached through a connection
you hand in. Import through your alias:

```jsonc
// tsconfig.json → compilerOptions (recommended alias)
"paths": { "@parts/*": ["./parts/*/src"] }
```

```ts
import { flags, FlagError } from "@parts/flags.feature";
```

Never deep-import `src/internal/**` (lint-enforced). No env, no adapter.

## 2. The connection seam (`SqlExecutor`)

The part is **driver-free**. Wrap your `pg` Pool once (copy `examples/pg-executor.ts`):

```ts
const db: SqlExecutor = {
  query: (sql, params) => pool.query(sql, params ? [...params] : undefined),
};
const ff = flags(db);
```

Run the migration before first use:

```sh
partkit migrate            # reads DATABASE_URL; creates feature_flags
```

## 3. Evaluate flags — the FAIL-SAFE hot path

```ts
const ff = flags(db);

// Always pass a fallback (your compiled-in default). evaluate NEVER throws — on
// an unknown flag, a type mismatch, or a DB hiccup it returns the fallback, so a
// flag outage can never take a request down.
if (await ff.evaluate("new-checkout", { subjectId: user.id }, false)) {
  // …new checkout…
}

const tier = await ff.evaluate("plan-tier", { attributes: { plan: user.plan } }, "standard");

// Resolve every active flag for a context in one query (bootstrap a client/SPA).
const all = await ff.evaluateAll({ subjectId: user.id, attributes: { plan: user.plan } });
```

- **`subjectId`** is a stable principal id (user/org). It is REQUIRED for sticky
  percentage rollout — without it, a rollout-only flag falls through to its
  default (it can't bucket deterministically).
- **`attributes`** drive targeting rules (see §4).
- The `fallback` you pass governs **unknown / archived** flags and any error.

## 4. Define flags — targeting rules + sticky rollout

```ts
await ff.setFlag({
  key: "new-checkout",
  type: "boolean",            // "boolean" | "number" | "string" | "json"
  enabled: true,
  default: false,             // value when ON but no rule/rollout decides
  rules: [
    // first-match-wins; a rule matches when ALL its conditions hold
    { conditions: [{ attribute: "plan", op: "eq", value: "enterprise" }], variant: true },
  ],
  rollout: [                  // sticky % split for everyone the rules didn't catch
    { value: true, weight: 10 },
    { value: false, weight: 90 },
  ],
});

await ff.getFlag("new-checkout");   // returns the def (incl. archived ones)
await ff.listFlags();               // active flags only
await ff.archiveFlag("new-checkout"); // soft-disable → evaluation uses your fallback
```

- **Resolution order (when enabled):** first-matching rule → sticky rollout (if a
  `subjectId` is present) → the flag's `default`.
- **Rule conditions** (`op`): `eq`, `neq`, `in` (value is an array), `contains`
  (string substring), `gt`, `lt` (numeric). A **missing attribute never matches**
  (including `neq`), so an attribute-less context falls through.
- **Rollout weights are relative** (need not sum to 100). Bucketing is a stable
  hash of `key + subjectId`, so a subject stays in the same bucket across requests
  and a 10% rollout is ~10% of subjects. Two flags with the same split don't
  correlate (the key salts the hash).
- **`enabled: false` is a kill switch** — evaluation returns the flag's own
  `default` (NOT your caller fallback). Use it to force a feature off to a known
  value. **Archiving** is different: it makes the flag invisible to evaluation, so
  your caller fallback governs (use it to retire a flag). Re-`setFlag` un-archives.

## 5. Error handling

`evaluate`/`evaluateAll` **never throw**. Only the management ops do, as a
`FlagError` with `.code`:

| code | meaning | typical HTTP |
|---|---|---|
| `invalid_input` | bad `setFlag` arguments — blank key, bad type, or a default/variant/rule value whose type ≠ the declared `type` | 400 |
| `storage` | the executor (database) failed. The raw driver error is on `.cause`; `.message` is generic. | 500 |

## 6. What you must NOT do

- Edit or import anything under `src/internal/**`.
- `SELECT`/`INSERT`/`UPDATE` `feature_flags` directly — use the flag set.
- Call `evaluate` without a `fallback`, or rely on it throwing — it won't.
- Expect a rollout to be sticky without a `subjectId`.
- Confuse **disabled** (→ flag default) with **archived/unknown** (→ your fallback).
