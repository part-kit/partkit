# 05 — Roadmap v0

## 1. Stack decision

One stack, excellent, before any second stack exists. Decision: **TypeScript / Next.js (App Router) / Postgres / deployed-anywhere-Node** — chosen not because it is the best stack but because it is where agent-built products overwhelmingly land today, which maximizes the chance a stranger's lockfile appears within 90 days. Adapters at launch: Stripe + Paddle (billing), SES + Resend + Postmark (email), S3-compatible (storage), Postgres-native (jobs via graphile-worker, full-text search).

A design constraint follows directly from this choice: the dominant deploy target is serverless, so **every part interface must be valid under stateless runtimes** (`02` §2). `jobs.queue` is the honest exception that proves the rule — a queue worker is a long-running process by nature — so that part ships both shapes behind one contract: an external worker for servers, a cron-invoked drain for serverless.

Deliberately deferred: the **iOS part pack** (StoreKit 2 subscriptions, Sign in with Apple, push, CloudKit sync, App Store review-pattern conformance). It is our most defensible vertical — 30 years of iOS, native parts are underserved, App Store review is exactly the human-judgment domain agents fail at — but it is a second ecosystem and second conformance harness. It enters the roadmap only after the kill criterion is passed, as the differentiation play.

## 2. The first ten parts

Authorship rule (revised 2026-06-11): parts are authored directly against best, most-used practices, validated by their conformance suites and the consumer e2e; real product builds remain the ideal feedback loop, and a real build that contradicts a contract triggers a contract revision. Interiors wrap proven OSS where it exists (Better Auth, graphile-worker) or speak vendor REST APIs directly with zero npm dependencies — we attest and contract; we don't rewrite (`02` §1). Authorship process and per-part priority queue: `07-part-author-manual.md`. The ten, in build order:

1. **email.transactional** — send + templates + delivery events. Built first: smallest contract and best first conformance suite, so it proved the entire toolchain (contract → conformance → attestation → CLI) on the cheapest part before the expensive ones. *Shipped 1.0.0 (2026-06-11): resend + postmark attested, 10 conformance tests each; delivery events arrive as an additive minor via `webhooks.ingest`. The vendor-flip demo lives here. **1.1.0 (2026-06-14): the SES adapter shipped** — SES v2 SendEmail signed with SigV4 by hand (zero deps, no `aws-sdk`; conformance anchors the signing to AWS's documented known-answer vector). It makes the planner's cheapest email pick a real one-commit flip (`partkit upgrade email.transactional --adapter=ses`) and turns the SES integration agents normally avoid into a one-line config choice.*
2. **auth.session** — email + OAuth sign-in, sessions, middleware guards; wraps Better Auth behind the contract. The part everything else requires. *Shipped 1.0.0 (2026-06-11), sixth in actual build order (human-checkpoint cleared): **first OSS-wrapping part** — wraps Better Auth, declaring `better-auth` + `pg` in `npm_dependencies` (RFC 0001, contract_version 0.2). v1 is email/password + sessions + guards (`authHandler` catch-all mount, `getSession`/`requireSession`, server-side `signUp`/`signIn`/`signOut`); OAuth is an additive 1.1 (providers as seams, not adapters). Owns `auth_*` tables via Better Auth's modelName mapping, created by `partkit migrate` (migration generated from Better Auth's own schema generator). Zero registry adapters. 7 conformance tests against real Better Auth + real Postgres: password hashed (scrypt, never plaintext), no account enumeration, session invalidation. Node-runtime only (pg, not Edge).*
3. **billing.subscription** — checkout, webhooks, plan state, cancel/upgrade. Hardest conformance (replay, ordering, races); the flagship attestation. v1 verifies its own inbound webhooks; may compose on `webhooks.ingest` from v2. *Shipped 1.0.0 (2026-06-12), tenth and last in actual build order — completes the saas core ten. Stripe adapter attested (`stripe@^22`, API pinned `2026-05-27.dahlia`); per-adapter `npm_dependencies` so a future Paddle adapter never drags in Stripe. Hosted Checkout + a webhook-derived subscription mirror on the `SqlExecutor` seam (`billing_subscriptions` + an append-only `billing_events` idempotency ledger); cancel/reactivate/change-plan; `entitled = status ∈ {active, trialing}`. **State derives solely from verified webhooks** — checkout writes no row, the success redirect grants nothing. Inbound verification is the part's own raw-HMAC (the `webhooks.ingest` mechanics, cross-checked against Stripe's own signer), so it is SDK/network-free; `email.transactional` (dunning) is deferred. 18 conformance tests against the **real Stripe test API** + real Postgres (item-level `current_period_end`, replay/idempotency, injection, secret redaction, append-only ledger). admin reads are read-only (RFC 0004). The vendor-flip + dunning email are the roadmap.*
4. **auth.tenancy** — organizations, memberships, roles, row-level scoping. The part agents get wrong most expensively. *Shipped 1.0.0 (2026-06-12), seventh in actual build order (after `auth.session`): zero-adapter/zero-env DB part on the `SqlExecutor` seam, owns `auth_tenant_organization` + `auth_tenant_membership`. `requireMembership` is the row-level-scoping gate (enumeration-safe: a missing org and a non-membership are indistinguishable); roles are ordered owner>admin>member. **First part to declare `requires`** (`auth.session>=1`) — it references the principal by opaque `user_id` with NO foreign key to `auth_user`, keeping the cross-part boundary in the database. Never-ownerless (create-org-with-owner is atomic) and last-owner protection are enforced in single-statement CTEs through a pooled connection; the simultaneous-double-demote race is a documented residual (needs SERIALIZABLE). 13 conformance tests — orgs/memberships/roles/last-owner/cascade/injection against real Postgres (gated on `PARTKIT_TEST_DATABASE_URL`), validation/typed-error/own-tables-and-no-cross-part-FK DB-free. **1.1.0 (additive minor, 2026-06-12):** adds `data_ownership.reads` (RFC 0004) so `admin.crud` can administer the org/membership tables — no interface, schema, or seam change (`migrations/1.0.0-1.1.0/seam-changes.md`).*
5. **storage.upload** — signed uploads, image variants. *Shipped 1.0.0 (2026-06-11), fifth in actual build order (zero deps, unblocked): in-part AWS SigV4 presigning of direct-to-storage PUT uploads and GET downloads for any S3-compatible provider (S3/R2/MinIO/B2/Spaces) — one wire format, so **no adapters** (provider = config: endpoint/region/path-style). Presigning is pure computation (zero network), so conformance is fully offline: signatures are anchored byte-for-byte to the AWS CLI (botocore) via known-answer vectors across path-style/virtual-hosted/ports/regions/unicode keys, the PUT path verified against an independent reimplementation. Image variants/transforms and POST-policy size limits are roadmap, not v1.*
6. **jobs.queue** — background jobs + retries + dead-letter; cron included; wraps graphile-worker; ships both worker shapes (§1). *Shipped 1.0.0 (2026-06-12), eighth in actual build order — the **first part through the isolated-conformance harness** (graphile-worker auto-isolated as a runtime dep, never a root devDep; attestation pins graphile-worker 0.16.6; `pg` declared in `conformance/package.json` as a test dep). **One part, two capabilities** (`jobs.queue@1` + `jobs.cron@1`). Enqueue + dead-letter read run through the `SqlExecutor` seam (serverless-safe, transactional, driver-free; graphile-worker loaded via a lazy dynamic import); processing ships both shapes — `runWorker` (server daemon) and `drainOnce` (serverless drain on the platform cron). Retry/backoff/dead-letter and cron (verified via backfill) from graphile-worker. Owns the `graphile_worker` schema (dedicated schema, a stronger boundary than the table-prefix convention — docs/02 §6 reconciled); migration generated from graphile-worker's own migrator and the worker's boot-time migrate is a verified no-op against it. 13 conformance tests against real graphile-worker + Postgres (gated), validation/typed-error/own-schema DB-free. The retry engine `webhooks.dispatch` composes on. Surfaced + fixed a harness type-detection gap (deps shipping types via `main` with no `types` field were treated as opaque).*
7. **webhooks.ingest** — generic verified-inbound-webhook receiver (billing and others compose on it). *Shipped 1.0.0 (2026-06-11), second in actual build order (zero deps, unblocked): stripe + standardwebhooks (the Svix wire format — Resend, Clerk) attested, 18 conformance tests each. Adapters are signature SCHEMES, not vendors; GitHub's scheme is excluded pending a capability RFC (it carries no signed timestamp). v1 replay defense is in-memory per instance — honest limitation in SPEC.md; durable defense arrives with the DB story.*
8. **audit.log** — append-only domain event log (P2 buyers love it). *Shipped 1.0.0 (2026-06-11), fourth in actual build order — the **first DB-backed part**: owns the `audit_events` table, ships `migrations/001-*.sql` applied by `partkit migrate`, append-only enforced by the database itself (UPDATE/DELETE/TRUNCATE triggers, not just a withheld mutator). Driver-free: the connection is the app-provided `SqlExecutor` seam (zero adapters, zero env, runs in the app's transaction). 9 conformance tests — persistence/append-only/query/injection against real Postgres (gated on `PARTKIT_TEST_DATABASE_URL`), validation/typed-errors DB-free.*
9. **ratelimit.api** — per-user/per-IP limits as middleware. *Shipped 1.0.0 (2026-06-11), third in actual build order (zero deps, unblocked): fixed-window limiter, built-in per-instance in-memory store + a typed pluggable-store seam (Redis = `INCR`/`EXPIRE`), IETF `RateLimit-*` headers, fail-open-by-default on store outage. First part with **zero registry adapters and zero env** — the store is an app seam, not a vendored adapter, so it publishes a single `default` attestation; 17 conformance tests run against both the built-in store and an independent reference store.*
10. **admin.crud** — schema-driven internal admin for owned tables; the "day 3" part every real product needs. *Shipped 1.0.0 (2026-06-12), tenth in build order — RFC 0004's `data_ownership.reads`: a generic back office over OTHER installed parts, driven entirely by their declared read surface. Reads project only declared, non-redacted columns (`redact:true` never fetched) through the `SqlExecutor` seam; writes dispatch to the parts' public-export mutators (admin.crud issues NO write SQL, so last-owner / append-only invariants stay enforced in the part); identifiers are validated + double-quoted and values parameterized. **No compile-time or runtime dependency on the parts it administers** — it adapts at runtime from contracts (conformance administers a fictional part to prove it). `requires: auth.session>=1` for staff auth; composes with `audit.log`. Owns no tables. 9 conformance tests (DB-free projection/boundary/injection + real Postgres: a redacted column is never fetched, a metacharacter key round-trips as data, a write flows through a mutator). The `backoffice` skeleton's distinctive part; completes the saas core ten bar `billing.subscription`. Existing parts gain `reads` only in NEW versions (hashed content): **`auth.tenancy` 1.1.0** (shipped same day) adds `data_ownership.reads` for organizations + memberships (delete → `deleteOrganization`, role update → `setRole`) so the demo back office has real administrable tables; more parts follow.*

Each part ships complete per spec: contract, conformance, seams.md, examples/, at least one attested adapter, migrations dir (empty at v1.0 but present — the habit matters).

## 2b. The demo set — sewing one working app (added 2026-06-11)

The meaningful demonstration is **one app, assembled by an agent writing only seams, that a homepage visitor watches happen and can then inspect**. The app is "acme" from `06-agent-walkthrough.md`, grown to exercise every part: a subscription team SaaS.

| App feature the visitor sees | Part underneath |
|---|---|
| Sign in (email + OAuth) | `auth.session` ✅ (email/password; OAuth in 1.1) |
| Organizations, invites, roles | `auth.tenancy` ✅ (orgs/memberships/roles + scoping gate; invites in 1.x) |
| Paid plans, checkout, cancel/upgrade | `billing.subscription` ✅ (stripe) |
| Welcome / receipt / invite emails | `email.transactional` ✅ |
| Stripe webhooks verified, replay-safe | `webhooks.ingest` ✅ |
| Avatar & logo upload | `storage.upload` ✅ |
| Weekly digest, retried side-effects | `jobs.queue` ✅ (queue + cron; both worker shapes) |
| Public API rate limiting | `ratelimit.api` ✅ |
| "Who did what" trail (auth + billing events) | `audit.log` ✅ |
| Internal back office | `admin.crud` ✅ (RFC 0004 reads/mutators) |

The agent writes only seams: the pricing page, `PlanCatalog`, org switcher, email templates, digest content — the product. (`flags.feature`, `search.fulltext`, `billing.usage` stay in the namespace but out of the demo set.)

**Homepage assets** (the demo *is* the benchmark run — `04` §3):

1. **The film** — a recorded run of the `06` transcript, ~90 seconds: prompt → resolve → add → seams → green CI. Leave the ✋ pre-commit wall moment in; the wall is the brand moment.
2. **The repo** — the assembled app, public and deployable, `parts.lock` front and center, with the diff-stat proof: "the agent wrote only these files."
3. **The flip** — the one-commit vendor-swap diff (resend → postmark, stripe → paddle) as a screenshot.
4. **The numbers** — the with/without benchmark per the `06` protocol.

**Demo-ready =** all ten parts attested + the acme repo green + assets 1–3 rendered (4 follows). Build *order* stays per `07` §4 — infrastructure prerequisites decide sequence; the demo set defines the finish line.

**Are UI components parts? No.** Parts are behavior with contracts; UI is the product, and the product is where apps must differ — so UI lives on the app side of the seam, accelerated but never owned: every part ships `examples/` with unstyled, shadcn-compatible reference seam UI (sign-in page, pricing page, org switcher) that the agent copies, restyles, and owns. We interoperate with shadcn rather than compete (`01` §5, `04` §1). Nothing visual is ever attested — but the demo repo gets a real styling pass, because looking good is part of the demonstration.

## 2c. Beyond the ten — the four skeletons (added 2026-06-12)

One demo proved the machine works on one app. The library's purpose is to
**assemble several kinds of app** from the same verified parts — that recombination
is the compounding return on each part. Four skeletons, defined as **App Packs**
(`registry/packs/*.json`, resolvable via `partkit plan --pack <name>`):

| Pack | Skeleton | Adds, beyond the shared core |
|---|---|---|
| `saas` | Team SaaS (the acme demo above) | `auth.tenancy`, `billing.subscription`, `admin.crud` |
| `ai-api` | AI app / API product | `auth.apikey`, `billing.usage`, `webhooks.dispatch` |
| `marketplace` | Content / marketplace | `search.fulltext`, `flags.feature` |
| `backoffice` | Internal tool / back office | `admin.crud` (otherwise all shared) |

The `ai-api` pack — the dominant category of agent-built product — required two
additions to the capability namespace, both accepted as the API-facing siblings
of existing parts: **`auth.apikey`** (RFC 0002, sibling of `auth.session`) and
**`webhooks.dispatch`** (RFC 0003, sibling of `webhooks.ingest`). Everything else
the four packs need was already in the namespace.

Build order stays per `07` §4: **Wave 1 finishes the core ten / the `saas`
skeleton; Wave 2** (`auth.apikey`, `webhooks.dispatch`, `billing.usage`,
`flags.feature`, `search.fulltext`) unlocks the other three. "Ten excellent
before any shallow" still governs — Wave 2 is sequenced, not parallel, and each
part meets the identical bar.

**Wave 2 status — `auth.apikey` shipped 1.0.0 (2026-06-14), first of the wave.**
The programmatic sibling of `auth.session` (RFC 0002): issue / scope / verify /
rotate / revoke long-lived `ak…` bearer keys. **Zero-dependency** (node:crypto)
and driver-free — keys are `<prefix>_<192-bit secret>`; only a salted one-way
HMAC-SHA256 digest + salt persist (a fast keyed hash, **not** a KDF — the
secret's entropy already defeats brute force and verify is the hot path; RFC 0002
amended accordingly). `verifyKey` discloses `revoked`/`expired`/`forbidden` only
*after* a constant-time secret match, so a guesser only ever sees `invalid` (no
existence oracle); a decoy hash keeps the unknown-prefix path timing-uniform.
`ownerId` is opaque, so it secures an API product with **no human login at all**.
13 conformance tests against real Postgres (issue/verify/scope/rotate/revoke/
injection, gated on `PARTKIT_TEST_DATABASE_URL`) + DB-free typed-error,
validation, own-table, and an HMAC known-answer vector. An adversarial pass
(timing/enumeration, scope bypass, secret leak, DoS, rotation abuse) hardened the
header path and the rotation-grace bound before publish. `billing.usage` +
`webhooks.dispatch` remain to make the `ai-api` pack installable.

**A skeleton is "done well"** — the standard a team actually adopts — only when
an assembled app demonstrates four things in the running product, not just in
tests: it is **robust** (the security exhibits are live — `429`, replay/tamper
rejection, scope refusal, unrewritable audit trail), **maintained** (upgrade and
vendor-flip shown as small diffs), **deployable in the team's own infra**
(boots on self-hosted Node + Postgres, no required managed vendor, `partkit
migrate` from clean), and **a team standard the guard enforces** (a teammate's
agent cannot hand-roll the capability past CI). This is the finish line in
`07` §8.


## 4. Definition of done, v0

A stranger with Claude Code and no contact with us can: read one page, run `partkit init`, ask their agent for "a SaaS with team billing and transactional email," and get a repo where the agent wrote only seams, `partkit verify` passes in CI, the boundary guard stops interior edits, every attestation is fresh and offline-verifiable — and switching email from Resend to SES is a one-line policy change, not a rewrite. This sentence, expanded step by step, is `06-agent-walkthrough.md` — the build is done when reality reproduces that transcript.

