# partkit

Verified, attested standard parts for AI coding agents — **the agent writes only the seams.**

PartKit packages each product capability (transactional email, webhook ingestion, auth, billing, …) as a **part**: vendored code with a machine-readable contract, a conformance test suite every adapter must pass, and a continuously re-issued signed attestation. Parts are copied into your repo shadcn-style — you own every line, you can read every line, and a boundary guard makes sure nobody (human or agent) edits part interiors and silently voids the attestation.

## Status: pre-v0 — name-claim release

This is an early release published to claim the package name. The CLI works, but the hosted registry (`registry.partkit.dev`) is **not live yet** — `partkit add` currently requires `--registry <path>` pointing at a local checkout of the registry. Watch [partkit.dev](https://partkit.dev) for the public launch.

## Commands

| Command | What it does |
|---|---|
| `partkit init` | Install the boundary guard (pre-commit + CI), `parts.lock`, and `AGENTS.md` rules |
| `partkit add <part>` | Vendor a part from the registry and pin it in `parts.lock` |
| `partkit verify` | Verify attestation integrity (hard fail) and freshness (warn; `--strict` to fail) |
| `partkit guard` | Fail if `parts/**` no longer matches `parts.lock` |

## The idea in one paragraph

Agents regenerate the same infrastructure on every project, slightly differently every time, unverified and unmaintained. PartKit gives agents a catalog of standard parts they can trust and never regenerate: contracts erase the differences between vendors, conformance suites make adapter claims true, attestations expire so "verified" always means *recently*. The agent's job shrinks to the seams — the part of your product that should be different.

MIT licensed. © PartKit authors.
