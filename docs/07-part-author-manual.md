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

## 4. Priority queue

Build in this order. Do not skip ahead past an unbuilt infrastructure
prerequisite — flag it instead (§5). The finish line for this queue is the
**demo set** (docs/05 §2b): all ten parts attested and the "acme" demo app
assembled from them with the agent writing only seams.

| # | Part | Guidance | Blocked on |
|---|---|---|---|
| 1 | ✅ `email.transactional` 1.0.0 | The exemplar (resend + postmark; SES later, needs SigV4 + real sandbox) | — |
| 2 | ✅ `webhooks.ingest` 1.0.0 | Shipped as specified (stripe + standardwebhooks; adapters are signature schemes, not vendors — GitHub's timestamp-less scheme needs a capability RFC first) | — |
| 3 | ✅ `ratelimit.api` 1.0.0 | Shipped as specified (in-memory fixed-window store + typed pluggable-store seam for Redis; zero deps). First **zero-adapter, zero-env** part — the store is an app seam, not a vendored adapter; publishes a `default` attestation. | — |
| 4 | ✅ `audit.log` 1.0.0 | Shipped — the first DB part. Owns `audit_events`, ships `migrations/001-*.sql`, append-only enforced in the DB (UPDATE/DELETE/TRUNCATE triggers). Driver-free `SqlExecutor` seam (zero adapters/env). **DB-conformance pattern for #5/#9**: persistence invariants run against a real database gated on `PARTKIT_TEST_DATABASE_URL` (publish with it set for a meaningful attestation), validation/typed-error invariants run DB-free so the suite still attests where no DB exists. | — |
| 5 | ✅ `storage.upload` 1.0.0 | Shipped — in-part SigV4 presigning (PUT upload + GET download), zero deps, no adapters (one S3 wire format; provider = config). Presigning is pure computation, so conformance is fully offline: **known-answer vectors captured from the AWS CLI (botocore)** anchor signatures byte-for-byte; the PUT path (CLI presigns GET only) is checked against an independent in-suite reimplementation. The optional real-MinIO round-trip is gated on `STORAGE_TEST_ENDPOINT` (none in CI yet). Image variants + POST-policy limits are roadmap. | — |
| 6 | ✅ `auth.session` 1.0.0 | Shipped — the **first OSS-wrapping part** (wraps Better Auth; `better-auth` + `pg` in `npm_dependencies`, contract_version 0.2). Pattern for future wrapped parts: derive the migration from the library's own schema generator; map tables to the part prefix via the library's modelName config; conformance runs the real library + real Postgres. v1 email/password + sessions + guards; OAuth → 1.1 (providers as seams). The strict gate's `--skipLibCheck` (added 5feb411) is what lets a part import a real OSS lib's `.d.ts`. | — |
| 7 | `jobs.queue` | Wraps graphile-worker via `npm_dependencies`; ships both worker shapes (server daemon + serverless cron-drain) behind one contract (docs/05 §1). | — |
| 8 | `auth.tenancy` | After auth.session; row-level scoping patterns. | auth.session |
| 9 | `billing.subscription` | The flagship. Hardest conformance (replay, ordering, checkout/webhook races — docs/02 §4). Stripe test-mode keys are a **human checkpoint**. | webhooks.ingest, auth.session |
| 10 | `admin.crud` | Schema-driven admin for part-owned tables. Needs a data-ownership "reads" story — small spec RFC first. | several above |

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
- [ ] `npm run check` green; docs updated where reality diverged; one commit

---

## Launch prompt (copy-paste into a fresh session)

```
You are the PartKit part author. Work in this repository.

Read, in order: docs/02-part-specification.md, docs/07-part-author-manual.md,
every file of the exemplar part at registry/parts/email.transactional/1.0.0/,
and AGENTS.md. Run `npm install && npm run check` and confirm green before
writing anything.

Then build the next unbuilt part from the manual's Priority queue (§4),
following the process in §3 exactly: capability spec → contract → conformance
tests FIRST → implementation → seams.md / examples / SPEC.md →
`npm run registry:publish` → consumer e2e test → `npm run check` → one commit.

One part per session. Stop and ask at every Human checkpoint (§6). Never
weaken the core schemas, the strict tsconfig, severity tiers, or the boundary
rules. If reality and the docs disagree, reconcile both explicitly in the same
commit. Your final message must list: what shipped, conformance results per
adapter, and anything you flagged for a human.
```
