# PartKit

**A neutral registry of production-grade, verified standard parts that AI coding agents trust and never regenerate.**

Agents rebuild the same infrastructure (auth, billing, email, jobs) on every project — slightly differently every time, unverified and unmaintained. PartKit packages each capability as a **part**: vendored code with a machine-readable contract, a conformance suite any adapter must pass, and a continuously re-issued signed attestation. The agent writes only the **seams**; a boundary guard makes part interiors mechanically untouchable.

Status: **pre-v0, under construction.** The docs corpus in [`docs/`](docs/) is the source of truth; [`docs/06-agent-walkthrough.md`](docs/06-agent-walkthrough.md) is the transcript this implementation must reproduce.

## Layout

| Path | What |
|---|---|
| `docs/` | PRD, part specification, architecture, strategy, roadmap, golden transcript |
| `packages/core` | `@part-kit/core` — contract/lockfile/attestation schemas, hashing, registry client, the init/add/verify/guard operations |
| `packages/cli` | `partkit` — the CLI (reference implementation of the protocol) |
| `registry/` | The static v0 registry content (capabilities + parts; served as files/CDN, no service) |

## Development

```sh
npm install
npm run check   # typecheck (strict-compile gate) + tests
```

The root tsconfig **is** the strict-compile gate we impose on parts (`docs/02-part-specification.md` §4) — do not weaken it.

## License

Code: [MIT](LICENSE). The "PartKit Attested" mark is reserved — the mark, the freshness machinery, and the transparency log are the moat; the code is the free carrier.
