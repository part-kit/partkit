# SPEC — billing.subscription 1.0.0

Subscription billing over a vendor-neutral contract, with the **stripe** adapter
attested for v1. Hosted checkout, a webhook-derived subscription mirror in the
app's Postgres, cancel/reactivate/change-plan, and a derived entitlement flag.

## Design decisions

- **Stripe is a registry adapter, not baked in.** `billing.subscription@1` is
  vendor-neutral; Stripe/Paddle/LemonSqueezy are interchangeable by construction
  against the same conformance suite (the email.transactional / webhooks.ingest
  pattern). v1 attests only `stripe`; the vendor-flip (`partkit upgrade
  --adapter`) lands when a second adapter is built. Per-adapter
  `npm_dependencies` keep a future Paddle adapter from dragging in `stripe`.
- **`stripe@^22`, API pinned `2026-05-27.dahlia`.** Verified current (22.2.1).
  The docs/02 §2 draft's `^17.0.0` was stale and has been corrected. The API
  version is pinned explicitly in the client so an SDK patch can't silently
  change wire behavior. (Two v22 specifics the part depends on: a subscription's
  period end is read at the **item** level — `items.data[0].current_period_end`,
  not the sub root — and immediate cancel is `subscriptions.cancel`, not the
  removed `.del`.)
- **Webhook verification is raw `node:crypto` HMAC, not `stripe.webhooks.constructEvent`.**
  Byte-identical to the algorithm proven in `webhooks.ingest`, and it keeps
  verification SDK- and network-free so conformance exercises it offline. The
  conformance suite cross-checks our verifier against Stripe's own
  `generateTestHeaderString` so the wire format can't drift. The SDK is a runtime
  dep for the **write** calls (checkout/cancel/change), not for verification.
- **State derives solely from verified webhooks.** `createCheckout` writes no
  row; the success redirect grants nothing. Only `ingestWebhook`, after signature
  verification, upserts `billing_subscriptions`. Lifecycle methods return an
  optimistic snapshot but never write the mirror.
- **Idempotency by vendor event id.** `billing_events` is an append-only ledger
  with a `UNIQUE(stripe_event_id)`; an event recorded once is applied once.
  `billing_events` UPDATE/DELETE are blocked by a DB trigger (the audit.log
  pattern), so the dedupe record can't be tampered to force reprocessing.
- **The part never owns the principal.** `user_id` is an opaque string with no
  FK to any `auth.session` table — the cross-part boundary lives in the DB. The
  app plan id rides through Stripe subscription metadata (`plan_id`) so the
  mirror resolves it without a read-time catalog.
- **No card data, ever.** The schema holds only ids, plan id, status, period
  end, and event type/time — no PANs, CVCs, or raw payloads.
- **Entitlement = `status ∈ {active, trialing}`**, computed at read time.
- **Email deferred.** No `email.transactional` edge in v1 (`requires` is
  `auth.session>=1` only); dunning/receipt email composes in a future minor.
- **Admin reads are read-only** (`data_ownership.reads`, RFC 0004): an admin can
  inspect subscriptions/events but not mutate them via generic CRUD — billing
  changes must flow through the real lifecycle methods and Stripe, which keeps
  the webhook-as-source-of-truth model intact. No `mutations` are declared.

## Invariant → conformance mapping

| # | Invariant | Test(s) | Block |
|---|---|---|---|
| 1 | No-I/O import; failures are typed + secret-redacted | "importing performed no I/O…", "a storage error surfaces as a typed BillingError with secrets redacted" | A |
| 2 | Invalid input fails fast, zero side effects | "blank/unknown planId or empty userId fails fast … ZERO SQL + ZERO vendor calls" | A |
| 3 | Webhook idempotent under at-least-once delivery | "a redelivered event id … records and applies at most once" | C |
| 4 | State derives solely from verified webhooks | "createCheckout … writes NO subscription row" (A); "a verified subscription.created upserts the mirror" (C); "createCheckout returns a real session url and writes no mirror row" (D) | A, C, D |
| 5 | Signature + window verified before any state change | "correctly-signed verifies", "decoy v1 still verifies", "tampered/wrong-secret/missing rejected", "timestamp outside ±300s rejected", "agrees with Stripe's own signer" | B |
| 6 | No card data stored; ledger append-only | "stores only ids/plan/status/period — no card/raw column", "billing_events is append-only" | C |
| 7 | Owns only billing_ tables; parameterized; opaque user_id | "upsert targets ONLY billing_ tables and binds every value as a parameter" (A); "SQL metacharacters round-trip literally" (C) | A, C |
| 8 | Entitlement = status ∈ {active, trialing} | "entitlement true for active" (C); "active → canceled flips entitlement" (C); "a real subscription … is entitled with an item-level period end" (D) | C, D |

Conformance runs in the isolated harness with only `stripe` installed (`pg` is a
`conformance/package.json` test dep). Blocks A (DB-free) and B (offline
signature) always run; C needs `PARTKIT_TEST_DATABASE_URL`; D additionally needs
`STRIPE_TEST_SECRET_KEY` + `STRIPE_TEST_PRICE_ID` and drives the real Stripe test
API. All 18 tests pass against real Stripe test mode + real Postgres.

## Threat model

- **Forged webhooks / privilege escalation via fake "subscription active".**
  Mitigation: every inbound event is HMAC-verified over the raw bytes against
  `BILLING_WEBHOOK_SECRET` before any parse or write; state is written only from
  verified events; the success redirect and client input grant nothing.
- **Replay.** A captured valid event replayed later is rejected by the ±300s
  timestamp window; a redelivery within the window is deduped by the unique event
  id (applied once). Tampering the ledger to force reprocessing is blocked by the
  append-only trigger.
- **Secret leakage.** Stripe/driver errors can embed the secret key or
  connection string; every error path wraps with `redactSecrets` so secrets
  never reach a message or log. Env vars are marked `secret`.
- **SQL injection.** All statements are constant and fully parameterized;
  metacharacters in ids are stored literally (conformance proves a `DROP TABLE`
  payload round-trips as data).
- **Card data exposure.** None is stored — the schema cannot hold it.
- **Cross-part overreach.** The part writes only `billing_*` tables and
  references the principal by opaque id with no FK, so it can't read or corrupt
  another part's data.

Residual / out of scope for v1: the in-process `onSubscriptionChange` registry
is not a cross-process bus (the DB mirror is the durable signal); a webhook
endpoint with an out-of-sync signing secret rotation must be handled by the
operator (both old+new secrets during rotation is a future enhancement).

## Roadmap

- Dunning + receipt email by composing on `email.transactional` (additive minor).
- A second vendor adapter (paddle) → the attested vendor-flip demo.
- Compose inbound verification on `webhooks.ingest` (v2) instead of the part's
  own verifier, once a shared multi-event-source story exists.
- Usage-based add-ons via `billing.usage` (sibling capability).
