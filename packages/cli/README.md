# partkit

Verified, attested standard parts for AI coding agents — **the agent writes only the seams.**

PartKit packages each product capability (transactional email, webhook ingestion, auth, billing, …) as a **part**: vendored code with a machine-readable contract, a conformance test suite every adapter must pass, and a continuously re-issued signed attestation. Parts are copied into your repo shadcn-style — you own every line, you can read every line, and a boundary guard makes sure nobody (human or agent) edits part interiors and silently voids the attestation.

## Status: pre-v0

The hosted registry (`registry.partkit.dev`) is **live** and serves the catalogue, so `partkit add` works out of the box. Attestations are dev-tier (unsigned; real signing is on the roadmap). Watch [partkit.dev](https://partkit.dev) for the public launch.

## Commands

| Command | What it does |
|---|---|
| `partkit init` | Install the boundary guard (pre-commit + CI), `parts.lock`, and `AGENTS.md` rules |
| `partkit add <targets...>` | Vendor parts, a pack, or `part[@version][:adapter]` specs — resolves order, pulls `requires`, skips installed. e.g. `partkit add saas` or `partkit add email.transactional:postmark storage.upload` |
| `partkit plan <capabilities...>` | Resolve capabilities into a deterministic install plan (no changes made) |
| `partkit audit` | Did the repo respect its contracts? Boundary + attestations + routes/env/sprawl in one pass |
| `partkit upgrade <part>` | Upgrade a part's version and/or flip its adapter — you get only the seam changes |
| `partkit verify` | Verify attestation integrity (hard fail) and freshness (warn; `--strict` to fail) |
| `partkit guard` | Fail if `parts/**` no longer matches `parts.lock` |
| `partkit migrate` | Apply pending part-owned database migrations |

A **pack** is a curated capability kit for a product shape — `partkit add saas` installs the whole Team-SaaS skeleton (auth, billing, email, webhooks, jobs, storage, rate limiting, audit, admin) in one command, resolving order and picking sensible default adapters.

## The idea in one paragraph

Agents regenerate the same infrastructure on every project, slightly differently every time, unverified and unmaintained. PartKit gives agents a catalog of standard parts they can trust and never regenerate: contracts erase the differences between vendors, conformance suites make adapter claims true, attestations expire so "verified" always means *recently*. The agent's job shrinks to the seams — the part of your product that should be different.

MIT licensed. © PartKit authors.
