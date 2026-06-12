# 06 — Agent Walkthrough (the golden transcript)

This fixture is written *before* the code, on purpose. It serves three roles: the design spec for MCP response shapes, the script for the launch benchmark, and the executable form of the v0 definition of done (`05` §4). When implementation and this document disagree, one of them is wrong on purpose — decide which, then update both.

## Cast and setup

A stranger. Claude Code (any MCP-capable harness works; this transcript assumes Claude Code). A fresh repo:

```
npx create-next-app@latest acme --ts
cd acme && git init
npx partkit init
```

`partkit init` installs: the pre-commit hook, the CI boundary-guard workflow (which also scans app imports — only `parts/<name>/src/index` is legal), formatter ignores for `parts/**`, an empty `parts.lock`, the `partkit verify` CI step, and `AGENTS.md` (the registry rules plus the live list of installed parts).

## The prompt

> "Build me a SaaS with team billing and transactional email."

## Step 1 — The agent learns the rules without being told

The agent opens the repo and reads `AGENTS.md`:

> Infrastructure capabilities in this repo come from the PartKit registry. Before implementing auth, billing, email, jobs, storage, or uploads: call `resolve_plan` (MCP) or run `partkit plan`. Never edit files under `parts/**` — interiors are attested; edits void the attestation and fail CI. Each installed part documents what you must write in its `seams.md`. Installed parts: (none yet).

## Step 2 — Resolve

The agent calls MCP `resolve_plan`:

```json
{
  "capabilities": ["billing.subscription", "email.transactional", "auth.session", "auth.tenancy"],
  "lockfile": {},
  "constraints": { "framework": "next@16", "node": "22", "db": "postgres" },
  "policy": { "trust": "attested-only" }
}
```

Response — this shape is normative: compact, deterministic, and the no-edit rule travels with the plan, not only with the skill:

```json
{
  "plan_id": "sha256:…",
  "install_order": [
    { "part": "auth.session",         "version": "1.4.2", "adapter": null,     "reason": "required by auth.tenancy and billing.subscription" },
    { "part": "auth.tenancy",         "version": "1.1.0", "adapter": null,     "reason": "requested: team billing implies organizations" },
    { "part": "email.transactional",  "version": "2.0.1", "adapter": "resend", "reason": "requested" },
    { "part": "billing.subscription", "version": "1.3.0", "adapter": "stripe", "reason": "requested" }
  ],
  "env_required": ["DATABASE_URL", "EMAIL_ADAPTER", "RESEND_API_KEY", "BILLING_ADAPTER", "BILLING_SECRET_KEY", "BILLING_WEBHOOK_SECRET"],
  "migrations": "4 part(s) own tables — run `partkit migrate` after add (ledger: _part_migrations)",
  "seams_to_write": [
    "auth.session: sign-in/sign-up pages (examples/ available); session provider mount",
    "auth.tenancy: org switcher UI; invite acceptance page",
    "email.transactional: your domain's templates (welcome, receipt)",
    "billing.subscription: PlanCatalog (your plans + Stripe price IDs); pricing page; mount POST /api/webhooks/billing (one-line re-export)"
  ],
  "rules": ["Do not edit parts/** — interiors are attested. Write only the seams listed above. Each part's seams.md has type signatures and examples."]
}
```

## Step 3 — Install

```
partkit add auth.session
partkit add auth.tenancy
partkit add email.transactional --adapter=resend
partkit add billing.subscription --adapter=stripe
```

Each command: vendors the part (selected adapter only), pins version + attestation hash in `parts.lock`, scaffolds `.env.example`, merges declared `npm_dependencies` into package.json (RFC 0001), and flags parts that ship migrations — `partkit migrate` applies them (docs/02 §6). The installed-parts list in `AGENTS.md` updates.

## Step 4 — The agent writes only seams

Concretely, for this task: a `PlanCatalog` implementation with the product's plans and Stripe price IDs (typed; validated by the contract test the part ships); the webhook mount — `app/api/webhooks/billing/route.ts` is one line, `export { billingWebhookHandler as POST } from "@/parts/billing.subscription"`; sign-in/up pages copied from `auth.session/examples/` and restyled; the org switcher; two email templates; a pricing page. Domain logic and UI — the actual product — is all the agent's.

## Step 5 — Verify

`partkit verify` runs in CI: every attestation signature and content hash checks out offline against `parts.lock` (hard-fail class); freshness is within 14 days (warn class). The boundary guard re-hashes `parts/**` against the lockfile. Green.

## Step 6 — The wall (recovery vignette)

Mid-task, a type error: the agent passed `priceId` where `planId` was expected and — pattern-matching on the error's location — tries to "fix" `parts/billing.subscription/src/index.ts`. The pre-commit hook rejects:

> ✋ parts/billing.subscription/src/index.ts is a part interior — read-only.
> Edits void the attestation and will fail CI.
> Fix: `git checkout HEAD -- parts/` , then change YOUR side of the seam.
> What this part expects from you: parts/billing.subscription/seams.md

The agent restores, reads `seams.md`, fixes its `PlanCatalog`. This error text is product copy, not plumbing — it is the single highest-leverage UX moment in the system, because it is where an agent learns, in context and exactly when it matters, how the boundary works.

## Step 7 — The flip

Two weeks later: "switch email to Postmark." `partkit upgrade email.transactional --adapter=postmark` swaps the adapter. The diff: lockfile, adapter directory, one env line. Zero seam changes — the contract didn't move. This diff is the screenshot that markets the registry (`04` §3). (Adapter *cost-optimization* — the resolver picking a vendor from priced metadata — is deliberately out of v0; it returns when adapters carry pricing data the conformance CI can keep honest.)

## Benchmark protocol

This transcript, run two ways — with the registry (skill + MCP + parts) and without (vanilla agent) — N times each on fresh repos. Record: first-run success (does CI pass with zero human edits?), total tokens, wall-clock to green CI, count of human interventions. Publish raw transcripts alongside the numbers; the methodology page is published *before* the runs, and the without-registry runs are not cherry-picked. The benchmark is the launch asset; its credibility is the launch asset's asset.

---
*Status: normative fixture. The MCP server + resolver shipped 2026-06-11 (`@part-kit/mcp`) reproducing step 2's shape; v0 additionally emits `adapter_choices`/`notes` when policy cannot decide an adapter, and `already_satisfied` for anti-sprawl skips. Versions/adapters shown above are future-cast. Update this document together with `02` and `03`.*
