# 08 — Demo App Brief: the waitlist micro-SaaS

This document turns a fresh agent session into the builder of the **first
composed demo** — a small real product assembled from the four shipped parts,
consuming PartKit exactly the way a stranger does: the published npm CLI
against the live hosted registry. The copy-paste launch prompt is at the end.

It is deliberately NOT the full "acme" demo (docs/05 §2b needs all ten
parts). It is the smallest app that makes composition visible — and it
doubles as the first extraction feedback loop: where a contract fights the
build, the contract is wrong (docs/05 §2, authorship rule).

## 1. The product

**Waitlist** — a landing page where people join a waitlist for a product.
One page, one API, real infrastructure underneath:

| Feature | Part | Seam the agent writes |
|---|---|---|
| `POST /api/join` is rate-limited per IP | `ratelimit.api` | the middleware mount + limit policy |
| Every signup is an unrewritable audit event | `audit.log` | the `SqlExecutor` seam + the append call |
| New members get a welcome email | `email.transactional` | the template + the send call |
| Email delivery events arrive as verified webhooks | `webhooks.ingest` | the route mount + an `onWebhook` handler appending delivery status to the audit log |

That last row is the money shot: **two parts composed through a seam the
app owns** — webhook events flowing into the audit trail with the agent
writing only the handler between them.

## 2. Rules (same as any consumer repo)

- **The published toolchain only**: `npm i -D partkit` (≥0.2.0), default
  registry (`registry.partkit.dev`), no local checkout of the PartKit
  monorepo, no `--registry` flag. The demo is a dogfood run.
- **The agent writes only seams.** `partkit init` installs the boundary; the
  guard and `AGENTS.md` rules apply to the demo session itself. Never edit
  `parts/**`. If a contract genuinely fights the build, do NOT eject or work
  around it silently — record it (see §4); that signal is half the point.
- Fresh repo, own directory (e.g. `~/code/partkit-demo-waitlist`), own git
  history. Never work inside the PartKit monorepo checkout.
- Stack: Next.js (App Router) + Postgres, per the reference stack (docs/05 §1).

## 3. Build order

1. `create-next-app`, `git init`, `partkit init`.
2. `partkit plan ratelimit.api audit.log email.transactional webhooks.ingest` — or resolve over MCP. Install the four parts per the plan (`email.transactional --adapter=resend`, `webhooks.ingest --adapter=standardwebhooks`).
3. `partkit migrate` against a local Postgres (`DATABASE_URL`) — audit.log
   ships `migrations/001`; the `_part_migrations` ledger is part of the demo
   story.
4. Write the seams, reading ONLY `contract.json` + `seams.md` per part. If
   you find yourself needing `src/`, that part's seams.md has failed its
   quality bar — record it (§4).
5. Email without credentials: construct the send call for real, catch the
   part's typed error when env is absent, and surface "email skipped (no
   RESEND_API_KEY)" in the UI — typed-error honesty is demo material, not a
   blemish. With a key present it just works.
6. Webhooks without a vendor: ship `scripts/send-test-webhook.mjs` that signs
   a Standard-Webhooks delivery (msg id + timestamp + HMAC over raw bytes —
   the SPEC documents the scheme) and POST it twice: first 200, replay 400.
   Verified ingestion and replay defense, demonstrable offline.
7. README walkthrough: setup, the two-terminal demo (join → audit trail →
   test webhook → delivery status in trail), and **the proof**: a diff-stat
   of the repo showing agent-written files vs vendored `parts/**`.
8. `partkit verify` and `partkit guard` green in the repo's CI workflow
   (init installed it).

## 4. Deliverables back to the mothership

The session's final message must include:

- the repo path + diff-stat proof (files written vs vendored),
- a **findings list**: every contract/seams friction, missing doc, confusing
  error, or moment the agent wanted to edit interiors — each one is either a
  part bug, a docs bug, or a future contract revision,
- rough effort stats (wall-clock, number of human interventions) — the
  proto-benchmark numbers (docs/06 protocol).

Do not fix PartKit itself from the demo session. Report; the platform
session reconciles.

---

## Launch prompt (copy-paste into a fresh session, OUTSIDE the monorepo)

```
You are building the PartKit demo app: a waitlist micro-SaaS assembled from
verified parts, writing only the seams.

Read https://partkit.dev and the brief at docs/08-demo-brief.md of the
PartKit repo if available; otherwise this prompt is self-sufficient.

Create a fresh Next.js (App Router) + TypeScript repo in a NEW directory
outside any existing project. Then: npm i -D partkit (≥0.2.0), npx partkit
init, and install from the live registry (the CLI default):

  npx partkit add ratelimit.api
  npx partkit add audit.log
  npx partkit add email.transactional --adapter=resend
  npx partkit add webhooks.ingest --adapter=standardwebhooks

Run npx partkit migrate against local Postgres (DATABASE_URL). Build: a
landing page with a join form; POST /api/join rate-limited per IP; each
signup appended to the audit log; a welcome email (catch the part's typed
error and show "email skipped" when no RESEND_API_KEY); a mounted webhook
route whose onWebhook handler appends delivery events to the audit trail; a
/trail page rendering the audit log. Add scripts/send-test-webhook.mjs that
signs a Standard Webhooks delivery and proves verify-then-replay-reject.

Hard rules: never edit parts/** (the pre-commit guard enforces this; the fix
for any error pointing into parts/ is on YOUR side of the seam — read that
part's seams.md). Wire every part from contract.json + seams.md alone.
partkit verify and partkit guard must be green at the end.

Your final message must list: the diff-stat proof that you wrote only seams,
every friction point with any part's contract/seams/errors (verbatim), and
rough wall-clock + intervention counts.
```
