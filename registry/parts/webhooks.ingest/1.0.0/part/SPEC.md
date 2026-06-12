# webhooks.ingest — SPEC

Verify inbound webhooks — HMAC signature over raw bytes, signed-timestamp
window, replay defense — behind a contract-stable interface with pluggable,
attested signature-scheme adapters. v1 scope is **verification and dispatch**;
durable cross-instance replay defense arrives with the DB story.

## Design decisions

- **Adapters are signature schemes, not vendors.** `stripe` is Stripe's
  `t=…,v1=…` scheme; `standardwebhooks` is the Svix wire format (Resend,
  Clerk, anything following standardwebhooks.com). One scheme covers every
  vendor that speaks it — the adapter list grows by scheme, not by company.
- **Every v1 scheme must carry a signed timestamp.** That keeps invariant 3
  uniform across adapters — the same conformance suite, unweakened. GitHub's
  `X-Hub-Signature-256` (no timestamp) is deliberately excluded; admitting it
  needs a capability RFC (capability.json notes).
- **Zero npm dependencies.** Both schemes are ~80 lines over `node:crypto`.
  The security-critical primitives — `timingSafeEqual` comparison, the
  window check with an explicit NaN guard — live once in
  `src/internal/crypto.ts`; adapters only parse wire formats.
- **Signature before window.** Adapters check the HMAC first, so a
  `timestamp_out_of_window` error always refers to an *authentic* delivery —
  unauthenticated garbage can never probe the clock window.
- **Sign with raw header strings.** The timestamp is HMAC'd as the raw `t=`
  string, never re-stringified from a parsed number (leading zeros would
  silently break authentic signatures).
- **Replay key = the matched signature.** Identical for byte-identical
  replays; fresh on legitimate redeliveries (both schemes re-sign retries
  with a new timestamp). Scheme-independent, so the invariant is uniform.
- **Ack only after handlers complete.** A 2xx tells the vendor "delivered,
  never again" — answering it before app handlers finish would convert any
  crash into silent event loss. Handler failures answer 500 → redelivery.
- **A mount with zero handlers answers 500, not 200.** A deploy that mounts
  the route but forgot registration must not acknowledge (and thereby
  destroy) events; the vendor's retry queue is the safety net.
- **Lazy configuration.** Importing the part performs no I/O and never
  throws; env is read and validated at call time with typed errors
  (docs/02 §2, serverless-safe).
- **Conformance signs with independent fakes.** `conformance/fake-sender.ts`
  reimplements each vendor's signing algorithm from its documentation —
  adapter and suite must agree at the wire format, not at shared code.

## Invariant → conformance test mapping

| # | Invariant (contract.json) | Test (conformance/verify.test.ts) |
|---|---|---|
| 1 | Import performs no I/O; config validated at call time | "invariant 1: config is validated at call time…" |
| 2 | Bad/missing/tampered signature rejected, timing-safe compare | "invariant 2a/2b/2c/2d…" |
| 3 | Signed timestamp outside ±tolerance rejected | "invariant 3a/3b/3c…" |
| 4 | Replay within window rejected (in-memory, per instance) | "invariant 4: the identical delivery replayed…" |
| 5 | Verification over raw bytes; re-serialization fails | "invariant 5: verification is over raw bytes…" |
| 6 | Typed WebhookError with HTTP status; secrets never in messages | "invariant 6: failures are typed…" |
| 7 | 2xx only after handlers; 400 generic; 500 redelivers | "invariant 7a/7b/7c/7d…" |

## Threat model

- **Forged deliveries.** Everything hinges on the HMAC: signatures are
  recomputed over the exact raw payload bytes and compared with
  `crypto.timingSafeEqual` (no early-exit byte comparison, no string `===`).
  Wrong secret, tampered payload, tampered signature, and re-serialized JSON
  are all conformance-tested rejections.
- **Replayed deliveries.** Two layers: the signed-timestamp window (default
  ±300 s) bounds the replay horizon; the in-memory signature cache rejects
  byte-identical replays inside it. **Honest limitation:** the cache is per
  instance — on serverless, N concurrent instances can each accept the same
  replay once. The residual risk is bounded by handler idempotency, which
  seams.md §3 requires for at-least-once delivery anyway. Durable defense is
  a planned additive minor (roadmap).
- **Timestamp manipulation.** The window rejects both past AND future
  timestamps (clock-skew abuse), and the check has an explicit finite-ness
  guard — `NaN` compares false against every bound and would otherwise pass.
  Only the signed header timestamp is exposed (`event.timestamp`); payload
  timestamps are untrusted app data.
- **Information disclosure.** `webhookHandler` answers verification failures
  with a generic 400 — code, scheme detail, and clock window never reach an
  unauthenticated caller. `WEBHOOK_SECRET` is scrubbed from every error
  message (redaction list in `src/internal/config.ts`).
- **Resource exhaustion.** The replay cache is capped at 10 000 entries with
  expired-first eviction — an attacker flooding garbage cannot grow it
  (unverified deliveries are never cached) and a burst of legitimate traffic
  degrades replay coverage, never memory safety.
- **Event loss (availability).** Acknowledgement ordering (invariant 7) makes
  the vendor's retry queue the durability layer: handler crash → 500 →
  redelivery. The part never stores events; durable processing is the app's
  seam (record + enqueue, idempotent).

## Roadmap

- `1.1` (minor, additive): durable replay defense — a part-owned
  `webhooks_seen` table behind the same interface, once `partkit migrate`
  exists. The in-memory cache stays as the zero-config default.
- `github` adapter: requires a capability RFC first — the scheme has no
  signed timestamp, so invariant 3 cannot hold as written (capability.json
  notes the rule).
- Composition: `email.transactional` 1.1 delivery events arrive through this
  part (its SPEC.md roadmap), exercising `requires` resolution for real.
