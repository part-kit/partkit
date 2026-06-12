# 07 — Part Author Manual

This document turns a fresh agent session into a part-production line. It is
written so that a capable coding agent (Claude Code with Opus-class or better,
any harness) can author registry parts **without any context beyond this
repo**. The human's copy-paste launch prompt is at the end.

The exemplar is `registry/parts/email.transactional/1.0.0/` — it is the
pattern. When this manual and the exemplar disagree, stop and reconcile;
when either disagrees with `docs/02-part-specification.md`, the spec wins.

## 0. Before anything

Read, in this order:

1. `docs/02-part-specification.md` — the spec; the contract schema is the heart of the system
2. This manual, fully
3. The exemplar part, every file: `registry/parts/email.transactional/1.0.0/part/`
4. `AGENTS.md` (repo working rules) and `packages/core/src/contract.ts` (the schema as code)

Then confirm the toolchain: `npm install && npm run check` must be green
before you write anything. If it is not, fixing that is your first task.

## 1. The quality bar (non-negotiable)

1. **The strict-compile gate.** Part `src/`, `adapters/`, and `examples/`
   must compile under `--strict --exactOptionalPropertyTypes
   --noUncheckedIndexedAccess --skipLibCheck` (run automatically by
   `registry:publish`). skipLibCheck skips a dependency's shipped `.d.ts`
   only — your own source is fully strict-checked.
2. **Serverless-safe interfaces** (docs/02 §2). Importing a part performs no
   I/O and never throws. Configuration is read lazily and validated at call
   time with typed errors. No long-lived processes, no cross-request memory,
   no background threads. Durable state belongs in part-owned tables.
3. **Wrap, don't rewrite.** Prefer speaking vendor REST APIs directly with
   node primitives (zero npm dependencies — the email part's adapters are the
   pattern). Wrapping proven OSS (Better Auth, graphile-worker) is right when
   the domain demands it: declare the packages in `npm_dependencies`
   (`contract_version` 0.2, ranges part-wide and/or per-adapter — RFC 0001,
   docs/02 §2) and justify each one in SPEC.md design decisions.
4. **Invariants ↔ conformance, 1:1.** Every `invariants` line in contract.json
   maps to at least one named conformance test, and SPEC.md carries the
   mapping table. Write the conformance suite BEFORE the implementation —
   review effort concentrates on tests (docs/02 §4).
5. **Conformance runs against protocol-faithful fakes** (real HTTP servers
   mimicking the vendor wire format — see `conformance/fake-vendor.ts` in the
   exemplar), or real vendor sandboxes when credentials exist. Never against
   mocks of our own code. The same suite runs unchanged against every adapter.
6. **Security defaults are not optional:** typed errors only (raw vendor
   responses never escape), secret redaction in every error path,
   header/input-injection defenses, fixed endpoints (test-only base-URL
   overrides documented in SPEC.md), bounded retries.
7. **seams.md is sufficient alone.** An agent reading only `contract.json` +
   `seams.md` must be able to wire the part without opening `src/`. If it
   can't, the part has failed conformance in spirit (docs/02 §8).
8. **`examples/` compiles in place** (relative imports, adjusted by the user
   after copying) and is explicitly outside the boundary.
9. **Portable and composable — the "deployed anywhere, by a whole team"
   bar.** Two obligations that make a part trustworthy as shared
   infrastructure, not just correct in isolation:
   - *Portability.* A part may never **require** a specific managed vendor to
     function. Durable state lives in part-owned Postgres tables; the part runs
     on plain Node + Postgres a company can self-host. Managed services
     (Redis, S3, a vendor API) enter only as an app-provided *seam* or an
     interchangeable adapter — never as a hard dependency baked into `src/`.
     (`ratelimit.api`'s store seam and `storage.upload`'s any-S3 stance are the
     precedents.)
   - *Composition.* When a part is designed to work with another (a queue
     draining a dispatcher, an audit trail recording another part's events),
     `seams.md` must document the composition seam explicitly and `examples/`
     must show it wired. A part that composes only in theory has not earned the
     claim. The skeletons in §4 are assembled out of exactly these seams — they
     must exist for the library to feel like one app rather than ten utilities.

## 2. Layout rules (mechanical, enforced by tooling)

- `src/index.ts` is the only import surface; everything else under
  `src/internal/`. Part code never imports app code (docs/02 §8).
- Adapters live registry-side at `adapters/<name>/`; vendoring flattens the
  chosen one to `adapters/selected/`. Therefore: part code imports
  `../adapters/selected/adapter.js`, adapter files import
  `../../src/internal/*.js`, and **adapter files must sit at exactly that
  depth** so imports survive the flatten.
- Every adapter exports `export const adapter: <CapabilityAdapter>` with a
  `name` matching its directory.
- **A part may legitimately ship zero adapters** when its pluggable backend is
  an app-provided *seam* rather than a vendored vendor integration
  (`ratelimit.api` is the precedent: the store is a seam). Then `adapters: []`,
  there is no `adapters/` directory, and publish issues one `default`
  attestation. Likewise `env: {}` is valid when a part is configured purely in
  code — not every part has env or secrets.
- `migrations/` exists even when empty (`.gitkeep`). Parts that own tables
  ship `migrations/NNN-description.sql`, forward-only from `001`, applied by
  `partkit migrate` (docs/02 §6).
- **Test-only deps go in `conformance/package.json`**, never in `npm_dependencies`.
  If the conformance suite needs a package the part itself does not (a DB part
  whose conformance opens a real `pg` connection, say — the part uses the
  SqlExecutor seam and has zero runtime deps), declare it there as a
  `devDependency`. The isolated harness installs it as test toolchain and never
  pins it in the attestation (runtime deps only — RFC 0001). Add it from the
  part's FIRST version: `conformance/` is part of the content hash, so it cannot
  appear in a later patch without changing an immutable version's hash.
- Relative imports are **extensionless** (`./internal/errors`). Parts are
  vendored TS consumed by the app's bundler — extensionless is the one shape
  Next (Turbopack and webpack), Vite, and tsc's bundler resolution all agree
  on; `.js` specifiers broke every fresh Next 16 consumer (issue #1). The
  publish gate compiles with `--moduleResolution bundler` accordingly.

## 3. The process, per part

Work on a branch. One part per session.

1. **Capability spec first.** Write
   `registry/capabilities/<name>/v1/capability.json` (interface, invariants —
   mirror the exemplar's). If the capability is NOT in the namespace list in
   docs/02 §3 → **human checkpoint** before proceeding.
2. **contract.json** per docs/02 §2. Validate early:
   `npm run registry:check -- --part <name> --version 1.0.0` (it parses the
   contract before anything else).
3. **Conformance suite** — before implementation. Fakes + tests named
   `"invariant N: …"`. Include the unglamorous cases for the domain: replays,
   duplicate delivery, out-of-order events, races, partial failure (docs/02 §4
   lists them; pick what applies).
4. **Implement** `src/` + adapters to make the suite pass:
   `npm run registry:check -- --part <name> --version 1.0.0` until green.
5. **seams.md, examples/, SPEC.md** (SPEC.md must contain: design decisions,
   the invariant→test mapping table, a threat model section, a roadmap note).
6. **Publish:** `npm run build && npm run registry:publish -- --part <name>
   --version 1.0.0`. This runs the strict gate + conformance per adapter,
   issues dev attestations, and updates `registry/index.json`.
7. **Consumer proof.** Add a test following
   `packages/cli/test/registry-parts.test.ts`: temp repo → `initRepo` →
   `addPart` → `verifyRepo` ok, plus part-specific assertions (env scaffold,
   flattened adapter, AGENTS.md entry).
8. **`npm run check`** green at repo root.
9. **Commit** (one part per commit): `feat(registry): <name> 1.0.0 (<adapters>)`,
   ending with `Co-Authored-By: <your model name> <noreply@anthropic.com>`.
   Stage with explicit paths (your part's files plus exactly what you
   changed) — never `git add -A`; the tree may host another session
   (AGENTS.md).
10. **Docs honesty pass.** If reality diverged from docs/02 or docs/05 while
    building, update the doc in the same commit and say so in the commit body.
    Never silently drift.

## 4. What to build — the four skeletons and the build order

The library exists to **assemble whole-app skeletons** — verified
infrastructure a team standardizes on, deployable into their own infra, where
the agent writes only the product seams. Each skeleton is an **App Pack**
(`registry/packs/<name>.json`, the canonical capability list; resolvable via
`partkit plan --pack <name>`). The same parts recombine across packs — that
reuse is the proof the library compounds.

| Pack | Skeleton | Distinctive parts beyond the shared core |
|---|---|---|
| `saas` | Team SaaS (the reference; the acme demo) | `auth.tenancy`, `billing.subscription`, `admin.crud` |
| `ai-api` | AI app / API product | `auth.apikey`, `billing.usage`, `webhooks.dispatch` |
| `marketplace` | Content / marketplace | `search.fulltext`, `flags.feature` |
| `backoffice` | Internal tool / back office | `admin.crud` (else all shared) |

Shared core across packs: `auth.session`, `storage.upload`, `audit.log`,
`ratelimit.api`, `email.transactional`, `jobs.queue`, `webhooks.ingest`.

Build in order. Do not skip past an unbuilt infrastructure prerequisite — flag
it instead (§5). **Wave 1 finishes the `saas` skeleton (the acme demo,
docs/05 §2b); Wave 2 unlocks the other three packs.** Wave 2 is *sequenced
after* Wave 1, not parallel to it — "ten excellent before any shallow" still
governs; each Wave-2 part meets the identical bar (§1, §7).

### Wave 1 — finish the core ten (the `saas` skeleton)

Shipped, and now the **reference patterns** to copy:

- ✅ `email.transactional` 1.0.0 — the exemplar; zero-dep vendor-REST adapters (resend + postmark); the vendor-flip demo.
- ✅ `webhooks.ingest` 1.0.0 — adapters are signature *schemes* not vendors (stripe + standardwebhooks); the protocol-faithful fake-vendor pattern.
- ✅ `ratelimit.api` 1.0.0 — first **zero-adapter, zero-env** part; pluggable backend as an app *seam*, single `default` attestation.
- ✅ `audit.log` 1.0.0 — first DB part; the **DB-conformance pattern** (real-PG invariants gated on `PARTKIT_TEST_DATABASE_URL`, validation/typed-error invariants DB-free) reused by every DB part below; DB-enforced append-only.
- ✅ `storage.upload` 1.0.0 — zero-dep, no-adapter (one S3 wire format, provider = config); offline conformance via AWS-CLI known-answer vectors; the **portability** precedent (any S3-compatible host, self-hostable MinIO).
- ✅ `auth.session` 1.0.0 — first **OSS-wrapping part** (Better Auth; `npm_dependencies`, contract_version 0.2); migration derived from the library's own schema generator. The pattern for every wrapped part.
- ✅ `auth.tenancy` 1.0.0 — orgs/memberships/roles + the **row-level-scoping gate** (`requireMembership`, enumeration-safe); first part with a **`requires` edge** (`auth.session>=1`) — references the principal by opaque `user_id` with **no FK** to `auth_user` (cross-part boundary kept in the DB). Never-ownerless and last-owner rules enforced in single-statement **CTEs** (atomic through a pooled `SqlExecutor`); zero-adapter/zero-env DB part. 13 conformance tests.

Remaining, in this order:

| # | Part | Guidance | Blocked on |
|---|---|---|---|
| 7 | `jobs.queue` | Wraps graphile-worker via `npm_dependencies` (the `auth.session` OSS-wrap pattern; needs the isolated-conformance harness, §5). Ships both worker shapes behind one contract — server daemon + serverless cron-drain (docs/05 §1) — and **provides both `jobs.queue@1` and `jobs.cron@1`** (one part, two capabilities; graphile-worker does both). The retry/backoff/dead-letter engine that `webhooks.dispatch` (#12) composes on. | — |
| 9 | `billing.subscription` | The flagship. Hardest conformance (replay, ordering, checkout/webhook races — docs/02 §4). **Composes on `webhooks.ingest`** for inbound verification — document and wire that seam (don't re-implement signature checking). Stripe test-mode keys are a **human checkpoint**. | webhooks.ingest, auth.session |
| 10 | `admin.crud` | Schema-driven admin over part-owned tables. Needs a data-ownership "reads" story — **small spec RFC first** (RFC 0004; how a part exposes its tables for read/admin without breaking the boundary). The `backoffice` pack's distinctive part. | data-ownership RFC; several above |

### Wave 2 — unlock the other three skeletons

Same bar, sequenced after Wave 1. Two new capabilities were added to the
namespace for the `ai-api` pack (RFC 0002, 0003 — already accepted); the rest
were already in the namespace, unbuilt.

| # | Part | Pack | Guidance | Blocked on |
|---|---|---|---|---|
| 11 | `auth.apikey` | ai-api | **New capability — RFC 0002 (read it first).** Programmatic key auth: issue/verify/rotate/revoke, hash-at-rest, constant-time verify, scopes. Prefer zero-dep (Node `crypto`). DB part (audit.log pattern). The API-facing sibling of `auth.session`. | auth.session |
| 12 | `webhooks.dispatch` | ai-api | **New capability — RFC 0003 (read it first).** Outbound signed webhooks: out-of-band delivery, capped-backoff retry, dead-letter, delivery log, **SSRF defense**. Reuses `webhooks.ingest`'s Standard-Webhooks signing (factor the shared scheme). **Composes on `jobs.queue` (delivery worker) and `audit.log` (attempt log)** — wire both seams. | jobs.queue, audit.log |
| 13 | `billing.usage` | ai-api | Metered/usage-based billing — the AI/API monetization backbone. Records usage events, aggregates per period, reports to the billing vendor. Shares Stripe plumbing with `billing.subscription`; the metering key is typically the `auth.apikey` id (document that seam). Stripe keys = **human checkpoint**. | billing.subscription, auth.apikey |
| 14 | `flags.feature` | marketplace, backoffice | Feature flags / kill switches / gradual rollout. DB-backed, evaluated in-process (no per-check network); deterministic bucketing for percentage rollouts. Low dependency — good Wave-2 opener. | — |
| 15 | `search.fulltext` | marketplace | Full-text search over app-declared content, Postgres-native (`tsvector`/`tsquery`/GIN) — portable, no external search service required. Owns its index tables + `partkit migrate` triggers to keep them current. | — |

## 5. Infrastructure queue (separate sessions, not part work)

When a part is blocked on one of these, build the prerequisite first in its
own session — or flag it to the human and pick the next unblocked part:

- ✅ `partkit migrate` — shipped 2026-06-11: applies part `migrations/` with
  the `_part_migrations` ledger (docs/02 §6); hash-verified, one transaction
  per migration, `-- partkit:no-transaction` escape hatch with a SPEC.md
  resume-path obligation
- ✅ `npm_dependencies` contract field — shipped 2026-06-11 (RFC 0001,
  docs/rfcs/): contract_version 0.2, ranges in contract, exact `npm:` pins
  in attestations, add merges package.json, verify fail/fail/warn tiers
- ✅ `partkit upgrade` / `partkit eject` — shipped 2026-06-11: adapter flip +
  version move with seam-changes surfacing; eject moves the code out of the
  boundary and voids the attestation
- ✅ MCP server + resolver — shipped 2026-06-11 (`@part-kit/mcp`, six tools
  over stdio; resolver in `packages/core/src/ops/resolve.ts`; shapes per
  `docs/06-agent-walkthrough.md` step 2)
- ✅ **Isolated-conformance harness** — shipped 2026-06-12
  (`scripts/conformance-harness.mjs`). A part that declares `npm_dependencies`
  (the OSS-wraps: `auth.session`, `jobs.queue`, …) is now attested in a
  throwaway workspace containing ONLY its declared deps + the runner — never the
  monorepo's `node_modules`. So **wrapped libraries no longer have to be root
  devDependencies** (the thing that did not scale to many libraries with
  conflicting peers), and a part cannot pass by leaning on a package that merely
  happens to be in the monorepo. `registry:publish` selects the path
  automatically: isolated when the part declares deps, in-repo for zero-dep
  parts (so the published zero-dep parts are untouched); `--isolated` /
  `--in-repo` override. Two dependency facets the harness handles, neither
  pinned in the attestation matrix (runtime deps only, RFC 0001): **untyped
  runtime deps** get their `@types/*` installed as build toolchain for the gate
  (pg → @types/pg), falling back to an opaque `declare module` when no `@types`
  exists; **test-only deps** (a DB part's `pg` driver used only by conformance
  to reach a real database) are declared in `conformance/package.json` and
  installed as test toolchain. Because `conformance/` is part of the content
  hash, that file can only be added in a NEW version — author it from a part's
  first version. jobs.queue is unblocked: graphile-worker is a runtime dep, so
  it auto-isolates and never touches root devDeps.
- **Pack definitions + `partkit plan --pack <name>`** — `registry/packs/*.json`
  exist (the four skeletons, §4); wire `plan`/resolver to accept `--pack` so an
  agent can scaffold a whole skeleton in one call. Small, high-leverage.
- **RFC 0004 — data-ownership "reads"** — before `admin.crud` (#10): how a part
  exposes its owned tables for read/admin without breaking the import boundary.
- Sigstore signing (replaces `dev:unsigned`; `verify` already fails closed on
  `sigstore:` until real verification exists — keep it that way)

## 6. Human checkpoints — stop and ask

- Adding a capability not in the docs/02 §3 namespace list
- Any change to the contract schema (`packages/core/src/contract.ts`)
- Anything requiring real vendor credentials or accounts
- Weakening any invariant, severity tier, or the strict tsconfig — these are
  decisions, not chores; do not make them unilaterally
- Publishing anything outside this repo (npm, registries, announcements)

## 7. Definition of done, per part

- [ ] `capability.json` exists (approved if new capability)
- [ ] `contract.json` validates; every invariant maps to ≥1 conformance test; mapping table in SPEC.md
- [ ] Conformance green for every attested adapter via `registry:publish` (which also enforces the strict gate)
- [ ] Attestations + `registry/index.json` updated and committed
- [ ] Consumer e2e test (init → add → verify) added and green
- [ ] `seams.md` sufficient without reading `src/`; `examples/` compiles in place
- [ ] SPEC.md has design decisions, invariant mapping, threat model, roadmap
- [ ] **Portable** (§1.9): no required managed vendor; runs on plain Node + Postgres
- [ ] **Composition seams** (§1.9): where the part is designed to compose, `seams.md` documents it and `examples/` wires it
- [ ] `npm run check` green; docs updated where reality diverged; one commit

## 8. Definition of done, per skeleton (the "done well" bar)

A part is correct in isolation; a *skeleton* is the thing a team adopts. When a
pack's parts are all attested, the skeleton is demonstrated **done well** only
when an assembled app proves all four — these are the moat, made visible:

- [ ] **Robust, no holes** — the security exhibits are live and observable: the
      `429` trips, the tampered/replayed webhook is rejected, the unscoped API
      key is refused, the audit trail cannot be rewritten. Not asserted in a
      test file — shown in the running app.
- [ ] **Maintained** — the upgrade and vendor-flip are demonstrated, not just
      possible: a one-command `partkit upgrade` and an adapter flip
      (`--adapter`) land as small diffs with seam-changes surfaced.
- [ ] **Deployable in the team's own infra** — the skeleton boots on
      self-hosted Node + Postgres (no required managed vendor); env is fully
      scaffolded; `partkit migrate` brings up every owned table from clean.
- [ ] **A team standard, enforced** — the boundary guard provably stops a
      *second* implementation: a teammate (or their agent) cannot hand-roll the
      capability past `partkit guard` / CI. "Everyone uses the verified part"
      is mechanized, not hoped for. Show the guard rejecting the shortcut.

The `saas` pack (the acme demo, docs/05 §2b) is the first skeleton held to this
bar; `ai-api` is the second. Build *order* is §4; this is the finish line.

---

## Launch prompt (copy-paste into a fresh session)

```
You are the PartKit part author. Work in this repository.

Read, in order: docs/02-part-specification.md, docs/07-part-author-manual.md,
every file of the exemplar part at registry/parts/email.transactional/1.0.0/,
and AGENTS.md. Run `npm install && npm run check` and confirm green before
writing anything.

Then build the next unbuilt part from the manual's build order (§4) — Wave 1
before Wave 2. If it is a new-capability part, read its RFC first (docs/rfcs/).
Follow the process in §3 exactly: capability spec → contract → conformance
tests FIRST → implementation → seams.md / examples / SPEC.md →
`npm run registry:publish` → consumer e2e test → `npm run check` → one commit.

Every part must be **portable** (no required managed vendor; runs on plain
Node + Postgres) and must document + wire its **composition seams** (§1.9) —
the parts assemble into the four skeletons in §4, so those seams must be real.

One part per session. Stop and ask at every Human checkpoint (§6) — including
adding any capability not already in the docs/02 §3 namespace. Never weaken the
core schemas, the strict tsconfig, severity tiers, or the boundary rules. If
reality and the docs disagree, reconcile both explicitly in the same commit.
Your final message must list: what shipped, conformance results per adapter,
which skeleton(s) the part advances, and anything you flagged for a human.
```
