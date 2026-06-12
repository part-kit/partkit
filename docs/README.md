# PartKit — docs corpus

**One-line thesis:** A neutral registry of production-grade, verified standard
parts that AI coding agents trust and never regenerate — the standard parts
catalog for the agent era. **Parts are verified and untouchable; you only sew
the seams.**

| Doc | Audience | Purpose |
|---|---|---|
| `02-part-specification.md` | Part authors, agent-harness authors | Anatomy of a part: contract, conformance, attestation, versioning, boundary rules |
| `03-architecture.md` | Engineering | Static registry, MCP interface, CLI, resolver, CI guard, security model |
| `05-roadmap-v0.md` | Everyone | Stack decision, the first ten parts, the demo set |
| `06-agent-walkthrough.md` | Everyone, esp. MCP/resolver authors | The golden transcript: a stranger's end-to-end session; benchmark script and MCP response-design fixture |
| `07-part-author-manual.md` | Part-authoring agent sessions | Quality bar, per-part process, priority queue, human checkpoints, launch prompt |
| `08-demo-brief.md` | Demo-builder sessions | The waitlist micro-SaaS composed from shipped parts |
| `rfcs/` | Everyone | Accepted changes to the contract schema and namespace |

Start with `02` — the contract schema is the heart of the system.
`06-agent-walkthrough.md` is the acceptance fixture the build reproduces.

Namespace governance: capabilities are a commons; additions and capability
version bumps go by RFC in this repository (docs/02 §3).
