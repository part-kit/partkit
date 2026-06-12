# ratelimit.api — SPEC

Fixed-window API rate limiting behind a contract-stable interface, with a
built-in per-instance in-memory store and a typed pluggable-store seam for
Redis-compatible backends. v1 scope is **fixed-window limiting + middleware**.

## Design decisions

- **The store is a seam, not an adapter.** There is no vendor and no wire
  protocol here — the pluggable backend is app-provided code. So this part
  ships **zero registry adapters** and **no env**: rules are per-route policy,
  configured in code. (First PartKit part with neither; the tooling vendors it
  as the `default` attestation.)
- **Fixed window, window encoded in the key.** `bucketKey = "<key>:<windowStart>"`
  where `windowStart = floor(now / windowMs) * windowMs`. A new window is a new
  key, so a stale bucket can never undercount the next window — store expiry is
  purely memory reclamation, never correctness. This also makes the store
  contract trivially Redis-shaped: `INCR` + `EXPIRE`, nothing time-aware.
- **The store stays dumb.** It only atomically increments a counter and
  returns the new value; all windowing, header math, and policy live in the
  part. One security-relevant primitive (the increment) is the entire store
  surface, so a correct Redis seam is two lines and hard to get wrong — except
  atomicity, which SPEC and seams.md both flag.
- **Store failures never throw.** A backend outage is absorbed into a degraded
  result per `failOpen` (default true). This both preserves availability (the
  limiter can't take the API down) and is a security control: a driver error
  may embed a `redis://user:pass@host` connection string, and swallowing it
  means those credentials never surface through us. The only thrown errors are
  `invalid_rule` / `invalid_config` — programming mistakes, caught at call time.
- **IETF `RateLimit-*` headers.** `Limit / Remaining / Reset` on every result
  via `rateLimitHeaders`, plus `Retry-After` on the `429`. `Reset` is
  delta-seconds (the widely-deployed convention), so clients self-throttle
  without clock sync.
- **Serverless-safe.** Importing performs no I/O and never throws; the built-in
  store is a module-scope singleton re-created per cold start (the only
  sanctioned in-memory state, docs/02 §2). Its per-instance limitation is
  exactly why the store is a seam.
- **Conformance proves store-agnosticism the way email proves adapter-agnosticism.**
  With no adapters to iterate, the suite instead runs every invariant via
  `describe.each` against the built-in store AND an independent `ReferenceStore`
  (different internals, fully async) — a test that passes cannot be coupled to
  the default store's internals. Fixed-window rollover is driven by fake timers,
  so it is deterministic without sleeping real seconds.

## Invariant → conformance test mapping

| # | Invariant (contract.json) | Test (conformance/ratelimit.test.ts) |
|---|---|---|
| 1 | Import performs no I/O; config validated at call time | "invariant 1: importing performs no I/O…" |
| 2 | First `limit` pass, next rejected (fixed window) | "invariant 2: first \`limit\` requests pass…" |
| 3 | Counter resets when the window elapses | "invariant 3: when the window elapses…" |
| 4 | Keys are isolated | "invariant 4: keys are isolated" |
| 5 | Accurate result fields + `RateLimit-*` / 429 / Retry-After | "invariant 5: result fields…" + "invariant 5: the middleware…" |
| 6 | Invalid rule fails fast, zero store calls | "invariant 6: an invalid rule fails fast…" |
| 7 | Store failure: fail-open default / fail-closed opt-in, no untyped escape | "invariant 7a/7b/7" |

Invariants 1–6 each run twice (built-in store and ReferenceStore); invariant 7
runs against a deliberately failing store.

## Threat model

- **Limit evasion via spoofed identity.** The default key is the client IP from
  `x-forwarded-for` / `x-real-ip`, which are client-settable unless a trusted
  proxy overwrites them. On untrusted ingress an attacker rotates the header to
  get a fresh budget per request. Mitigation: seams.md §4 documents the trust
  boundary and steers abuse-sensitive callers to an authenticated `identify`.
- **Shared-bucket denial of service.** Keyless requests fall back to one shared
  bucket; a single client can exhaust it and lock out all other keyless
  traffic. Documented; production callers must set a real `identify`.
- **Store-outage amplification.** Fail-closed turns a store blip into a total
  outage (the limiter becomes the DoS), so the default is fail-open with the
  result flagged `degraded` for alerting. Fail-closed is opt-in for endpoints
  where unmetered traffic is worse than rejection.
- **Credential disclosure through errors.** Store driver errors (which may
  contain connection URIs with passwords) are never propagated — they are
  caught and converted to a degraded result. There are no part-owned secrets
  to redact because the part holds none.
- **Memory exhaustion.** The in-memory store evicts expired buckets on write
  and caps the map at 100k entries (oldest-inserted shed first), so a flood of
  distinct keys degrades counting coverage, never memory safety.
- **Boundary-straddle burst (accepted v1 limitation).** Fixed windows admit up
  to `2 × limit` across a window edge. Acknowledged, not defended in v1;
  sliding-window is a future capability.

## Roadmap

- `1.1` (minor, additive): a durable, cross-instance store backed by a
  part-owned `ratelimit_counters` table once `partkit migrate` is wired in —
  the in-memory store stays the zero-config default, the DB store removes the
  per-instance caveat without external infra.
- Sliding-window / token-bucket algorithms: a new capability major or an
  `algorithm` field by RFC — they change the counting semantics, so they do
  not belong under `ratelimit.api@1`'s fixed-window contract.
- A first-party Redis store example graduating from seams.md into a tested,
  shipped `examples/redis-store.ts` once a protocol-faithful Redis fake (or a
  sandbox) is part of conformance.
