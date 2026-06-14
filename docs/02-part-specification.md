# 02 — Part Specification (v0 draft)

This is the heart of the system. A part is a **capability with a contract**, not a code snippet. Everything else — registry, CLI, drift bot, certification business — derives from this spec being precise.

## 1. Anatomy

```
parts/billing.subscription/
├── contract.json        machine-readable contract (this spec, §2)
├── SPEC.md              human-readable spec + threat model
├── src/                 implementation (vendored, boundary-protected)
│   ├── index.ts         the ONLY import surface (public interface)
│   └── internal/        never imported by app code (lint-enforced)
├── adapters/
│   └── stripe/          only the SELECTED adapter is vendored
├── conformance/         tests ANY adapter must pass (§4)
├── migrations/          versioned upgrade paths (§6)
├── seams.md             agent-facing: exactly what the app must implement
├── examples/            reference seam implementations — unattested, editable, OUTSIDE the boundary
└── ATTESTATION.json     signed verification record (§5)
```

Parts are **vendored** (copied into the repo, shadcn-style), not installed as hidden dependencies. The user owns and can read every line. Ownership without editability: the boundary guard (§7) makes interiors read-only in practice while keeping them auditable in principle. This combination — *you own it, you can read it, you don't touch it* — is what makes attestations meaningful and upgrades deterministic.

`partkit add` vendors only the selected adapter; the registry-side layout carries all of them, and the lockfile records which one is installed. `examples/` ships copy-paste seam starting points — explicitly unattested and freely editable. They exist to kill the regenerate-every-seam token burn without turning parts back into templates: the boundary is what makes a part a part, and examples live outside it.

Interiors wrap proven code; they do not rewrite it. The auth part wraps Better Auth, the jobs part wraps graphile-worker, billing adapters wrap official vendor SDKs. PartKit's contribution is the contract surface, the conformance suite, and the attestation — the same move we make for vendors, applied to OSS. This is what makes the catalog maintainable by a small team (§4).

## 2. The contract

`contract.json` is the machine-readable promise. Draft schema by example:

```json
{
  "part": "billing.subscription",
  "version": "1.3.0",
  "contract_version": "0.2",
  "provides": ["billing.subscription@1"],
  "requires": ["auth.session>=1", "email.transactional>=1"],
  "platform": { "node": ">=22", "next": ">=15 <17", "postgres": ">=16" },
  "adapters": [
    { "name": "stripe",        "vendor_api": "2026-04", "status": "attested",
      "npm_dependencies": { "stripe": "^22.0.0" } },
    { "name": "paddle",        "vendor_api": "v2",      "status": "attested" },
    { "name": "lemonsqueezy",  "vendor_api": "v1",      "status": "community" }
  ],
  "interface": {
    "exports": [
      "createCheckout(planId, userId): CheckoutSession",
      "getSubscription(userId): Subscription | null",
      "cancelAtPeriodEnd(subscriptionId): void",
      "onSubscriptionChange(handler): Unsubscribe"
    ],
    "events": ["subscription.created", "subscription.updated", "subscription.canceled", "payment.failed"],
    "http_routes": [
      { "route": "POST /api/webhooks/billing", "export": "billingWebhookHandler" }
    ]
  },
  "env": {
    "BILLING_SECRET_KEY":     { "required": true,  "secret": true },
    "BILLING_WEBHOOK_SECRET": { "required": true,  "secret": true },
    "BILLING_ADAPTER":        { "required": true,  "enum": ["stripe", "paddle", "lemonsqueezy"] }
  },
  "data_ownership": {
    "tables": ["billing_subscriptions", "billing_events"],
    "writes_only_own_tables": true
  },
  "invariants": [
    "Webhook handling is idempotent under at-least-once delivery",
    "No card data is ever stored or logged in the application",
    "Subscription state derives solely from verified webhook events, never from client input",
    "All adapter calls are retried with exponential backoff and surfaced as typed errors"
  ],
  "threat_model": "SPEC.md#threat-model",
  "license": "MIT",
  "attestation": "ATTESTATION.json"
}
```

Design rules for contracts — each one is load-bearing:

- **Invariants are testable claims**, not adjectives — every invariant line maps to at least one conformance test. (This rule retired the draft `slo` field: a latency promise returns to the contract the day the conformance harness can measure it under load, and not before.)
- **`requires` references capability versions, never concrete parts** — and the capability interface itself is defined in the namespace (§3), independent of any part.
- **`platform` declares runtime requirements** (Node, framework, Postgres). Platform is not a capability and never resolves to a part; the resolver checks it against the repo, and the attestation's dependency matrix (§5) proves which exact versions it was verified against.
- **`npm_dependencies` declares wrapped-OSS runtime packages** (RFC 0001, requires `contract_version` 0.2 so older parsers fail closed): semver *ranges*, part-wide and/or per-adapter — the effective set for an install is part-wide ∪ selected adapter's, so billing's stripe adapter never drags paddle's SDK into an app. `partkit add` merges them into the app's `package.json` (an incompatible existing range hard-fails with nothing touched); `partkit verify` fails on missing or out-of-range installs and warns when the installed version is in range but not the one the attestation pinned (`npm:` keys in the dependency matrix, §5). Types-only, transitive, and test-only packages never belong here.
- **Interfaces must be valid under stateless, serverless runtimes** — the reference stack's dominant deploy target. Module-scope registration re-evaluated per cold start is the only sanctioned subscription form (`onSubscriptionChange` registers the handler that the part's webhook route invokes during request handling). No export may assume a long-lived process, cross-request in-memory state, or background threads. Durable reactions belong in part-owned outbox tables or mounted routes.
- **`http_routes` are routes the app must mount**, not files the part owns. In App Router the route file lives in `app/` — app territory; parts never write into it. The mount is a one-line re-export of the declared handler export, and is itself a declared seam.
- **`data_ownership` names the tables a part owns** (`writes_only_own_tables` is its promise). Its optional `reads` map (RFC 0004) is a versioned read surface for schema-driven admin tooling: per table, the columns admin tools may `SELECT` (a `redact:true` column is never read) plus a `mutations` map pointing at public exports for any sanctioned write. Admin tools read only declared tables/columns and write only through those exports — so the import boundary and the part's invariants both hold, and the admin couples to the contract, not to interiors.
- The `interface` is the entire legal surface; everything else is `internal/`.

## 3. Capabilities are first-class

The namespace is flat, two-level, boring on purpose: `auth.session`, `auth.apikey`, `auth.tenancy`, `billing.subscription`, `billing.usage`, `email.transactional`, `storage.upload`, `jobs.queue`, `jobs.cron`, `audit.log`, `flags.feature`, `admin.crud`, `webhooks.ingest`, `webhooks.dispatch`, `search.fulltext`, `ratelimit.api`.

`auth.apikey` (programmatic key auth — issue/rotate/scope/verify) and `webhooks.dispatch` (outbound signed webhooks with retry + delivery log) were added to the namespace by RFC 0002 and RFC 0003 to make the AI-app / API-product skeleton assemblable from verified parts; see `docs/rfcs/`. They are the API-facing siblings of `auth.session` and `webhooks.ingest`.

A capability is a **versioned spec, not just a name**. Each namespace entry owns: the interface definition (the exports, events, and route shapes any implementing part must provide), the invariants, and the conformance suite (§4). Parts *implement* `billing.subscription@1`; `requires: auth.session>=1` therefore means something definite independent of which part satisfies it — two parts claiming the same capability version are interchangeable by construction, because they pass the same suite against the same interface. In v0, with one part per capability, the distinction is invisible; it becomes load-bearing the day a second provider appears, and it is what vendor certification certifies against (a vendor's adapter conforms to the *capability*, not to our part).

Namespace governance lives in the public registry repo; additions and capability version bumps by RFC. The namespace is a commons — capturing it for commercial advantage would kill neutrality (see `04-strategy-gtm.md`).

## 4. Conformance

The conformance suite is what makes an adapter claim true. It runs the *same tests against every adapter* using vendor sandboxes (Stripe test mode) or protocol-faithful fakes (a local SMTP sink for email), and includes the unglamorous cases that training-data-average code always gets wrong: webhook replay and duplicate delivery, out-of-order events, race between checkout completion and webhook arrival, refund and dispute flows, partial failure mid-migration.

The suite belongs to the capability, not the part (§3): a part inherits its capability's suite and may extend it, never weaken it. Conformance also includes a **strict-compile gate**: part source must compile under the strictest mainstream tsconfig (`strict` plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, bundler module resolution, and `skipLibCheck` — a part cannot fix a dependency's shipped `.d.ts`, and every strictest-mainstream config sets it), so interiors compile cleanly under any user tsconfig at or below that strictness — vendored code that fails the user's compiler is a boundary violation by other means.

Three trust tiers per adapter: `attested` (passes full conformance in our CI, signed), `community` (passes conformance in author's CI, run publicly reproducible, unsigned by us), `experimental` (exists, not yet conforming). Agents are instructed to prefer attested, allow community with a notice, and refuse experimental unless the human opts in.

Writing conformance tests is the expensive part of part authorship — and the part agents themselves are now good enough to draft, with human review concentrated exactly here. **Review effort goes into tests, not implementations.** That inversion — combined with interiors that wrap proven OSS rather than re-implement it (§1) — is the labor model that makes a small team able to maintain a registry.

## 5. Attestation

`ATTESTATION.json` is a signed record, re-issued by continuous verification (not at release time only):

```json
{
  "part": "billing.subscription",
  "version": "1.3.0",
  "adapter": "stripe",
  "verified_at": "2026-06-10T03:12:00Z",
  "dependency_matrix": { "node": "22.x", "next": "16.x", "postgres": "17", "stripe_api": "2026-04", "npm:stripe": "17.2.1" },
  "conformance_run": "https://ci.partkit.dev/runs/8f3a...",
  "tests_passed": 214,
  "result_hash": "sha256:...",
  "signature": "sigstore:...",
  "expires": "2026-06-24T00:00:00Z"
}
```

Properties that matter: attestations **expire** (14 days), so "verified" always means *recently, against current dependency versions* — this is the difference between a registry and a graveyard of templates. Signatures use a transparency log (Sigstore-style) so anyone can verify offline from the lockfile and detect tampering. The CI runs behind every attestation are public. Trust is earned by being checkable, not by being claimed.

Downstream, `partkit verify` maps attestation state to severities: signature or content-hash mismatch is **always a hard failure**; expiry is a **warning by default**, `--strict` opt-in. Integrity failures and freshness failures are different threats — one means tampering, the other means our cron is late — and they must never share a severity, or adopters will delete the check the first time we have a bad weekend (`03-architecture.md` §8).

The attestation mark ("PartKit Attested") is trademarked even while all code is MIT (decision closed, `01-prd.md` §10). The mark, the freshness machinery, and the transparency log are the moat; the code is the free carrier.

## 6. Versioning and migrations

Semver on the *contract*: patch = interior changes, no contract change; minor = additive interface/contract changes; major = breaking contract changes. Every minor and major ships a `migrations/<from>-<to>/` directory containing executable code transforms, data migrations, and `seam-changes.md` — an agent-readable description of exactly which seams the app must update, in imperative form ("rename the import X→Y; the `onChange` callback now receives..."). `partkit upgrade` applies interior changes mechanically and hands the agent only the declared seam changes. Because interiors are untouched by app code (§7), upgrades are deterministic operations, not archaeology.

**Database migrations.** Part-owned tables are namespaced by part prefix (`billing_*`) and form a boundary *in the database* that mirrors the one in the repo: part migrations touch only part-owned tables; app migrations never touch part tables; and app code never reads part tables directly — tables are interior, data exits through the interface. A part that wraps a library mandating its own Postgres schema (`jobs.queue` owns graphile-worker's `graphile_worker` schema) owns that whole schema rather than a table prefix — a dedicated schema is a *stronger* namespace boundary, not a weaker one, and the same rules apply: only the part's migration touches it, and app code reaches it only through the interface. Part migrations are forward-only, sequentially numbered SQL (`001-description.sql`), applied by `partkit migrate` (one transaction per migration; `partkit add` flags parts that ship migrations, and `partkit upgrade` will invoke the same runner) and recorded in a `_part_migrations` ledger — deliberately independent of the app's own migration chain (Drizzle, Prisma, raw SQL). The ledger stores each applied file's hash: an applied migration whose bytes later differ is treated as tampering and hard-fails, never re-runs. Because neither side may touch the other's tables, the relative ordering of part and app migrations is irrelevant; that invariant is what makes the independence safe rather than reckless. Where a migration cannot run transactionally (concurrent index builds), it declares so — first line `-- partkit:no-transaction` — and ships a verified resume path in SPEC.md; "partial failure mid-migration" is a standing conformance case (§4).

## 7. The boundary

The rule "agents never edit part interiors" is enforced four ways, in increasing order of authority:

1. **Skill-level**: the agent instructions shipped with the registry state the rule and explain why (editing voids the attestation).
2. **Guard-level import scan**: `partkit guard` itself scans every app source file's import specifiers and fails on anything under `parts/**` other than `parts/<name>/src/index` — enforced in the pre-commit hook and CI without assuming any particular linter (repos may add an ESLint mirror for editor-time feedback). `partkit init` also writes ignore entries for `parts/**` into the repo's formatter configuration — a repo-wide `prettier --write` must not be able to rewrite interiors and silently void lockfile hashes.
3. **Hook-level**: a pre-commit hook installed by `partkit init` rejects staged changes under `parts/**`, with error text that teaches the recovery path: *"Part interiors are read-only (edits void the attestation). Restore with `git checkout HEAD -- parts/` and change your side of the seam instead — see this part's seams.md."* (`HEAD`, not the bare form: at commit time the edit is already staged, and the bare form would restore the tampered index.) Agents hit the wall at edit time, not at PR time — and agents follow good error text. The hook never touches the network and fails closed with instructions when the CLI is missing.
4. **CI-level**: a check fails any diff whose `parts/**` content no longer hashes to `parts.lock`. The check is state-based, not provenance-based: "produced by `partkit add`/`upgrade`" is verified by hash match, never by trusting a tool's word. This one is non-negotiable and is installed automatically by `partkit init`. Note its limit: the hash guard protects against *accident* — a malicious PR can rewrite interiors and lockfile *consistently* and sail past it, which is why signature verification (`partkit verify`) runs in CI as the control against *malice* (`03-architecture.md` §8).

If a part genuinely doesn't fit, the sanctioned path is `partkit eject <part>`: copies the code out of the boundary, removes it from the lockfile, voids the attestation, and tells the agent it now owns that code. Ejection is honest exit, not failure — and ejection telemetry is the best possible signal for where contracts are too rigid.

## 8. Seams

Dependency direction is law: app code imports the part's `index.ts`; **part code never imports app code**. Every app-provided behavior enters through a declared, typed seam — a registration object, a config file the part reads, a handler passed at mount. This one-way arrow is what makes upgrades deterministic operations instead of archaeology, and it is checkable by the same lint that guards imports in the other direction.

`seams.md` in every part tells the agent exactly what the application must provide: which interfaces to implement, which events to subscribe to, which pages/routes to render, with type signatures. Seam code is validated where possible by contract tests the part ships ("your `PlanCatalog` must return at least one plan with a Stripe price ID"). Parts may ship `examples/` — reference seam implementations outside the boundary (§1): unattested, freely editable starting points the agent may copy and own. The design goal: an agent reading only `contract.json` + `seams.md` can wire a part correctly without reading `src/` at all. If it can't, the part's documentation has failed conformance in spirit.
