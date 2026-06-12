# RFC 0003 — `webhooks.dispatch` capability

**Status:** accepted 2026-06-12 (namespace addition authorized by Rado; chief-architect session)
**Adds capability:** `webhooks.dispatch@1`
**Unblocks:** the AI-app / API-product skeleton (App Pack `ai-api`); composes with `jobs.queue` (retries) and `audit.log` (delivery log)
**Author:** chief-architect session, 2026-06-12

## 1. Problem

`webhooks.ingest` verifies inbound webhooks — it answers "did this event
really come from Stripe?" The mirror problem is unsolved: an API product must
**send** signed webhooks to *its own* customers' endpoints, and that is where
home-grown code fails in ways that are invisible until a customer complains —
no signature (so the customer cannot verify us), no retry on a 503, no backoff,
no delivery log, no dead-letter, a slow customer endpoint blocking the request
that triggered the event, and SSRF straight into the cloud metadata endpoint
because the destination URL was never validated.

`webhooks.dispatch` is the verified outbound sender: sign, deliver
out-of-band, retry with backoff, record every attempt, dead-letter, and refuse
to call internal addresses. It is the API-facing sibling of `webhooks.ingest`
and reuses the **same Standard Webhooks signature scheme**, so a customer who
can verify an inbound `webhooks.ingest` payload can verify ours with the same code.

## 2. Interface (`webhooks.dispatch@1`)

```ts
// Enqueue is synchronous-fast: validate, persist, return. Delivery is out-of-band.
dispatch(input: {
  endpointId: string;           // a registered destination (url + secret)
  eventType: string;            // e.g. "invoice.paid"
  payload: unknown;             // JSON-serializable
  idempotencyKey?: string;      // dedupe re-enqueues of the same logical event
}): Promise<{ messageId: string }>;

registerEndpoint(input: {
  ownerId: string;
  url: string;                  // validated: https, public address only (§3.6)
  eventTypes?: string[];        // null = all
}): Promise<{ id: string; secret: string }>;   // secret returned ONCE

// Delivery worker drains the outbox; designed to run under jobs.queue.
deliverDue(opts?: { now?: Date; batch?: number }): Promise<DeliveryReport>;

listAttempts(messageId: string): Promise<DeliveryAttempt[]>;  // the delivery log
class DispatchError extends Error { code: "invalid_url" | "unknown_endpoint" | "invalid_payload" }
```

Signs each delivery with Standard Webhooks headers (`webhook-id`,
`webhook-timestamp`, `webhook-signature`) — byte-identical to what
`webhooks.ingest`'s `standardwebhooks` adapter verifies. Owns
`webhooks_dispatch_*` tables (endpoints, outbox, attempts) via `partkit migrate`.

## 3. Invariants (each maps to ≥1 conformance test)

1. Importing performs no I/O and never throws; `dispatch`/`registerEndpoint` validate input with typed errors and zero network calls.
2. **`dispatch` never performs the HTTP delivery inline** — it persists to the outbox and returns; a slow or hostile customer endpoint cannot block or fail the caller's request. Delivery happens only in `deliverDue`.
3. Every delivery carries a valid Standard Webhooks signature over `id.timestamp.payload`; a customer verifying with the shared secret accepts it, and any tampered byte makes verification fail.
4. **Delivery is retried with capped exponential backoff** on network error / 5xx / 429 (honoring `Retry-After`), up to a bounded attempt count; 4xx (except 429) is permanent and not retried. Every attempt — outcome, status, latency, next-retry — is recorded; exhausted messages move to dead-letter, never silently dropped.
5. **At-least-once with idempotency:** the same `idempotencyKey` enqueued twice yields one outbox row; the receiver may still see a redelivery, so the signed payload carries the stable `webhook-id` for receiver-side dedupe (documented in seams.md).
6. **SSRF defense (non-negotiable):** `registerEndpoint` and delivery refuse non-public destinations — `http://` (https only), loopback, link-local, RFC-1918 ranges, and the cloud metadata address `169.254.169.254` — resolved at delivery time, not just registration, to defeat DNS rebinding. Test-only overrides are documented in SPEC.md.
7. The endpoint secret is returned once, stored only as needed to sign, and never appears in errors, logs, or `listAttempts`.

## 4. Implementation notes for the part author

- **Zero npm dependencies preferred:** Standard Webhooks signing is HMAC-SHA256
  over `${id}.${timestamp}.${body}` — Node `crypto` does it; this is the same
  code `webhooks.ingest` already contains on the verify side, so factor the
  shared scheme into the part's `src/internal` rather than adding a dep.
- **Composition is the point:** `deliverDue` is built to be the body of a
  `jobs.queue` job (retries/backoff/dead-letter delegated to the queue where
  possible) and each attempt is an `audit.log` candidate. Author the part so it
  works standalone (call `deliverDue` from a cron) *and* documents the
  `jobs.queue` wiring as the production path — that composition seam is what
  makes the AI-API skeleton feel like one app.
- DB-backed → `audit.log` conformance pattern: outbox/retry/dead-letter/
  idempotency against real Postgres gated on `PARTKIT_TEST_DATABASE_URL`;
  signing, payload validation, and SSRF URL-rejection run DB-free.
- Conformance for delivery runs against a **protocol-faithful fake receiver**
  (a real local HTTP server that verifies the signature and can be scripted to
  return 200/500/429/slow) — the `webhooks.ingest` fake-vendor pattern,
  inverted.

## 5. Roadmap (not v1)

- Customer-facing endpoint-management UI as `examples/` seam (not attested).
- Per-endpoint circuit breaker / auto-disable after sustained failure.
- Replay-from-dead-letter operator action.
