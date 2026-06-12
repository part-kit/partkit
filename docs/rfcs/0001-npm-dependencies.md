# RFC 0001 — `npm_dependencies` in the contract schema

**Status:** approved by Rado 2026-06-11 (open questions resolved per recommendations); implemented same day
**Unblocks:** `auth.session` (#6, wraps Better Auth), `jobs.queue` (#7, wraps graphile-worker)
**Author:** chief-architect session, 2026-06-11

## 1. Problem

Parts are vendored source, not npm packages; their imports resolve against the
*app's* `node_modules`. A part that wraps proven OSS (docs/02 §1: wrap, don't
rewrite) therefore needs the wrapped library installed in the consuming app —
and today the contract has no way to say so. The zero-dep parts
(email.transactional, webhooks.ingest) sidestepped this by speaking vendor REST
directly; Better Auth and graphile-worker cannot be sidestepped without
rewriting them, which is exactly what we promised not to do.

## 2. Design

The same triangle as everything else: **the contract declares, the CLI
enforces, the attestation pins.**

### 2a. Contract declares a range

```jsonc
{
  "contract_version": "0.2",
  "npm_dependencies": { "better-auth": "^1.3.0" },          // part-wide interior deps
  "adapters": [
    { "name": "stripe", "vendor_api": "2026-04", "status": "attested",
      "npm_dependencies": { "stripe": "^17.0.0" } }          // per-adapter deps
  ]
}
```

- Both fields optional; flat `name → semver-range` maps. The *reason* each dep
  exists goes in SPEC.md design decisions (already mandatory), not the schema.
- **Per-adapter deps are required at the adapter level**: billing's stripe
  adapter must not drag paddle's SDK into the app. The effective set for an
  install is *part-wide ∪ selected adapter's*.
- Not allowed: types-only packages (vendor the types or use structural
  typing — nothing that exists only at compile time belongs in a runtime
  claim), transitive deps (npm's job), and conformance/test-only tooling
  (conformance runs registry-side).

### 2b. CLI enforces

- **`partkit add`** merges the effective set into the app's `package.json`
  `dependencies` and prints "run your package manager's install". shadcn
  precedent; our consumer is an agent, and determinism beats etiquette. If the
  app already has the package at an incompatible range, `add` **fails without
  touching anything** — version conflicts are a human decision.
- **`partkit verify`** gains three checks, severities per the
  integrity-vs-freshness doctrine (docs/03 §8):
  - dep missing from the app → **fail** (the part cannot function);
  - installed version outside the contract range → **fail** (the contract's
    claims don't hold);
  - inside range but ≠ the attestation's pinned version → **warn**
    (`--strict` to fail) — same class as attestation staleness.
- Implementation note: range checking adds the `semver` package to
  `@part-kit/core` (boring, proven); installed versions are read from
  `node_modules/<name>/package.json`.

### 2c. Attestation pins exact versions

The attestation's `dependency_matrix` gains `npm:`-prefixed keys
(`"npm:better-auth": "1.3.2"`) recording the exact versions conformance ran
against. This is what makes "verified recently, against current versions"
*real* for OSS-wrapping parts: the 14-day verification cycle re-runs
conformance against the latest in-range releases and re-pins — the drift bot
(the day-2 business) gets its hook here, for free.

What the attestation does **not** claim: a supply-chain audit of the wrapped
package. It claims the part's invariants hold against these exact versions.
SPEC.md threat models must say this plainly.

### 2d. Versioning: bump `contract_version` to "0.2"

Adding the field as optional-under-"0.1" would be silently unsafe: zod strips
unknown keys, so an old parser would accept a dep-carrying contract, skip the
installs, and ship a broken part. Bumping to "0.2" (schema accepts the enum
`"0.1" | "0.2"`) makes old tools — including the published CLI 0.1.0 —
**reject** contracts they cannot honor. Fail closed, same doctrine as
`sigstore:` signatures.

No `parts.lock` change: the effective dep set is derivable from the vendored
`contract.json`, which is already hash-pinned.

## 3. Open questions (decide before implementation)

1. **`add` writes `package.json` directly** — confirm, or instructions-only?
   (Recommended: write it, per 2b.)
2. **In-range-but-not-attested = warn** — confirm warn over fail.
   (Recommended: warn; it is freshness, not integrity.)
3. Should `contract_version: "0.2"` also be the moment any other pending
   schema nit lands? (None known today; asking to avoid a 0.3 next month.)

## 4. Implementation checklist (one session, post-approval)

- [ ] `packages/core/src/contract.ts`: version enum, both `npm_dependencies`
      fields with semver-range validation
- [ ] `docs/02-part-specification.md` §2: schema example + design rules
- [ ] `addPart`: effective-set merge, conflict hard-fail, install hint
- [ ] `verifyRepo`: the three checks (fail/fail/warn)
- [ ] Attestation `npm:` convention in `scripts/publish-part.mjs`
- [ ] Tests: contract validation, add-merge + conflict, verify severities
- [ ] docs/07: remove the "no npm-dependencies field yet" caveat (§1.3),
      unblock parts #6–#7 in the queue
