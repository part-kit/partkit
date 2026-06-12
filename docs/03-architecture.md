# 03 — Architecture

Five components. Build order matters: CLI and parts first (useful with zero infrastructure); the registry second — and the v0 registry is **static**: a git repo plus CDN-served JSON (one Vercel deployment serves partkit.dev and registry.partkit.dev from the same build — apps/web). Contracts are immutable per version; per-version manifest.json files give HTTP clients the file lists a static host cannot enumerate, with per-file sha256. Pre-launch the repo stays private — the git-history-as-transparency-record property begins when it opens at launch. The registry *service* gets built only when the drift bot and private registries need one — and by then it should be built from parts (dogfooding). Drift bot last (it's the revenue product and needs installed base to matter).

## 1. Component map

```
agent (Claude Code / Cursor / Codex)
   │  MCP: search, resolve, contracts, attestations
   ▼
registry (static v0: repo + CDN) ── verification CI (public runs, signs attestations)
   │                          │
   │  resolve plan            │ attestation feed
   ▼                          ▼
partkit CLI ──vendored──▶  app repo: parts/ + parts.lock + CI guard
                              ▲
                              │ watches lockfiles, opens upgrade PRs
                        drift bot (GitHub App)
```

## 2. PartKit CLI

Local-first; works against the public registry with no account. Commands:

`partkit init` — installs the CI boundary guard, the pre-commit hook, lint rules plus formatter/lint-fix ignore entries for `parts/**`, `parts.lock`, and drops `AGENTS.md` registry instructions into the repo (this file is how every agent that opens the repo learns the rules — harness-agnostic distribution). `AGENTS.md` also lists installed parts with pointers to each part's `seams.md`, so an agent knows what already exists without an MCP round-trip — the in-repo half of the anti-sprawl rule.

`partkit plan <capability...>` — runs the resolver (§4), prints the plan: parts, adapters, versions, env vars, migrations, seams to write (natural-language capability requests are the agent's job to translate; the CLI takes capability names). Agents call the MCP equivalent; the CLI version exists for humans and CI.

`partkit add <capability> [--adapter=X]` — vendors the part (selected adapter only), pins version + attestation hash in `parts.lock`, scaffolds env vars, merges declared `npm_dependencies` into package.json (RFC 0001), and flags shipped migrations — `partkit migrate` applies them (ledger: `_part_migrations`, see `02` §6).

`partkit upgrade <part> [--part-version=ver] [--adapter=X]` — vendors the new interior (temp-dir safe: integrity failure leaves the installed part untouched), updates lockfile/env-prefill/npm deps mechanically, and hands the agent only the declared seam changes (`migrations/<from>-<to>/seam-changes.md`). The adapter flip at the same version is the canonical one-commit vendor swap: lockfile + `adapters/selected/` + one env line, zero seam changes.

`partkit verify` — offline-verifies every attestation signature and content hash (hard failure on mismatch), and checks freshness and dependency-matrix match (warning by default, `--strict` to fail; see `02` §5). Runs in CI.

`partkit eject <part>` — sanctioned exit (see spec §7).

Implementation: TypeScript, single binary via bun or pkg. The CLI is also the reference implementation of the protocol — private registries (§7) speak the same API.

## 3. MCP server

Tools exposed to agents: `search_parts(query)`, `get_contract(part)`, `resolve_plan(capabilities[], lockfile, constraints)`, `get_attestation(part, version, adapter)`, `get_upgrade_plan(part, from, to)`, `get_seams(part)`.

Response design principles: compact and deterministic (agents reread these every session — token cost is product cost); invariants and seams stated imperatively; always include the "you must not edit interiors" rule in `resolve_plan` output so the rule travels with the plan, not only with the skill. Normative response shapes live in `06-agent-walkthrough.md` — the server is built to reproduce that fixture. The MCP server is stateless over the registry — in v0 that means reading the static repo/CDN directly; cache contracts aggressively (immutable per version).

## 4. Resolver

Input: requested capabilities, current `parts.lock`, stack constraints (framework, runtime, db), adapter preferences (e.g., cost-optimize → SES over Resend), and trust policy (attested-only vs. allow-community). Algorithm: build the capability graph from `requires` edges against the capability specs (capabilities are first-class and versioned — `02` §3); check each candidate's `platform` constraints against the repo's runtime; unify against already-installed parts (never install a second provider of a capability the lockfile already satisfies — this is the anti-sprawl rule that fixes the "five teams, five stacks" failure *within* a repo); select adapters by policy; emit a topologically-ordered install plan plus the union of seams. Determinism requirement: same inputs → same plan, always; the plan is reproducible from the lockfile alone. Conflicts (two parts requiring incompatible major capability versions) fail loudly with an agent-readable explanation — never auto-fudge.

## 5. Verification CI

The factory behind attestations. For every (part, version, adapter) in the attested tier: re-run full conformance — including the strict-compile gate (`02` §4) — every 14 days *and* on every dependency-matrix change (new Stripe API version, Next major, Node LTS), publish the run, sign the attestation into the transparency log, expire the previous one. Failures unpublish the attestation and trigger the drift bot. Expiry semantics downstream are deliberate: a lapsed attestation *warns* adopters, it does not fail them (`02` §5) — our bad weekend must never redden a stranger's CI; only integrity failures do that. Infrastructure: GitHub Actions initially (public, free, credible), with vendor sandboxes funded by us — this is a real ongoing cost and a real moat, because it's exactly the boring expense no app-builder startup wants to carry.

## 6. Drift bot (v1, first revenue)

GitHub App, installed per repo or per org. Watches `parts.lock`; subscribes to the attestation feed. On CVE, attestation expiry/failure, or contract-compatible part release: branch, run `partkit upgrade`, run the repo's own tests plus conformance smoke, open a PR with the seam-change notes as PR description. The pitch is one sentence: *your vibe-coded app gets a maintenance team for $X/app/month.* Pricing instinct: free for public repos (distribution), per-app monthly for private (value scales with what's at stake, not with seats).

## 7. Private registries (P2)

Same protocol, company-hosted (container we ship) or tenant-isolated SaaS. Companies author internal parts — *their* auth wrapper, *their* deployment target, *their* logging conventions — and set resolver policy: "capabilities X, Y, Z must resolve from the private registry; public registry allowed for the rest; attested tier only." Result: every team's agent, whatever the harness, assembles on the company's golden path, and outputs land deployable. Public and private parts coexist in one lockfile with per-part provenance. This is Backstage's promise, but enforced at the only chokepoint that matters now: the agent's moment of decision.

## 8. Security model

Threats, in order of severity: **(a) malicious part or adapter** — supply chain. Mitigations: vendored code is readable (no opaque dependency), attested tier requires our CI to have run the code in sandbox, transparency log makes substitution detectable, lockfile pins content hashes so the registry cannot silently swap code. **(b) compromised signing key** — Sigstore-style keyless signing with the transparency log; revocation = unpublish + drift bot alerts every affected repo. **(c) prompt-injection against the agent via part docs** — contracts and seams are data, and agents will read them; all registry-served text passes a lint that forbids imperative instructions outside the defined seam grammar, and the skill instructs agents to treat part docs as specification, never as instructions to change repo-level behavior. **(d) typosquatting capabilities** — namespace is governed, additions by RFC, fuzzy-match warnings in resolver. Honest acknowledgment: (c) is an open research problem industry-wide; our advantage is that part text is reviewed, versioned, and signed — a much narrower channel than the open web.

Division of labor between the two enforcement mechanisms, explicitly: the **boundary guard is the control against accident** — a state-based hash comparison of `parts/**` against `parts.lock`. **Signature verification in `partkit verify` is the control against malice** — a malicious PR can rewrite interiors and lockfile *consistently* and pass the hash guard, but it cannot forge the registry's signature over the content hash. `partkit verify` in CI is therefore load-bearing security, not hygiene; `partkit init` installs it alongside the guard so that opting out of integrity is a visible, deliberate act.

## 9. Stack choice for the system itself

Registry, v0: a static repo + CDN — nothing to build beyond the publishing pipeline. Registry service, v1+: the same reference stack the parts target, built *from* parts (dogfooding). DB: Postgres. Transparency log: Sigstore public-good infrastructure rather than self-hosted, until scale demands otherwise. Everything in the agent-facing path open source from day one; the hosted verification CI, drift bot, and private-registry control plane are the commercial code.
