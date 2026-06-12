# PartKit static registry (v0)

The v0 registry is **static content**: this directory, served as files over a CDN. Contracts are immutable per version; git history is the transparency record. There is no registry service until the drift bot and private registries need one (docs/03 §1).

## Layout

```
registry/
├── index.json                                  registry_version, part index (latest, versions, provides)
├── capabilities/<name>/v<N>/capability.json    the capability spec — interface + invariants + conformance, owned by the NAMESPACE, not by any part (docs/02 §3)
└── parts/<name>/<version>/
    ├── part/                                  full part content (all adapters; `partkit add` vendors only the selected one)
    └── attestations/<adapter>.json             per-adapter signed attestation, binds a content hash
```

## Rules

- Capability additions and version bumps go by **RFC** (docs/02 §3). The namespace is a commons.
- Parts are **extracted from real products** never written speculatively (docs/05 §2).
- Every attested adapter's conformance run must be public. Attestations expire after 14 days; the verification CI re-issues them.
- First part to land: `email.transactional` (smallest contract, proves the toolchain — docs/05 §2).
