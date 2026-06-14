# SPEC — billing.subscription 1.1.0

Subscription billing over a vendor-neutral contract, with the **stripe** and
**paddle** adapters attested. Hosted checkout, a webhook-derived subscription
mirror in the app's Postgres, cancel/reactivate/change-plan, and a derived
entitlement flag. 1.1.0 adds the paddle adapter (additive minor — the public
interface, schema, env keys, and migration are unchanged from 1.0.0; it adds a
new adapter plus a per-vendor webhook-header seam on the adapter contract).

## Design decisions

- **The payment vendor is a registry adapter, not baked in.** `billing.subscription@1`
  is vendor-neutral; `stripe` and `paddle` are both attested and interchangeable
  against the SAME conformance suite (the email.transactional pattern: one suite,
  a per-vendor profile selected by `adapter.name`). The vendor-flip is real:
  `partkit upgrade billing.subscription --adapter=paddle`. Per-adapter
  `npm_dependencies` keep the seams clean — `stripe` ships its SDK; `paddle` is
  **zero-dependency** (raw `fetch` + `node:crypto`), so selecting it pulls in no
  packages at all.
- **The paddle adapter is zero-dependency and absorbs Paddle's quirks behind the
  neutral interface.** Its writes speak Paddle's REST API over global `fetch`
  (POST /customers → POST /transactions for checkout; POST
  /subscriptions/{id}/cancel; PATCH /subscriptions/{id} for reactivate +
  change-plan); its verifier is the same raw-HMAC pattern with Paddle's wire
  format (`Paddle-Signature: ts=..;h1=..`, signed bytes `ts:rawBody`, key = the
  `pdl_ntfset_` secret used directly as UTF-8, multiple `h1` tolerated for
  rotation). Two Paddle realities it hides: there is no "subscription checkout"
  call (you create a transaction; the subscription is born on payment and arrives
  via webhook — so the mirror stays webhook-derived, same invariant 4), and a
  transaction binds to a `customer_id` not an email (so checkout ensures a
  Customer first, reusing the existing one on a 409). The per-vendor webhook
  header is declared on the adapter (`webhookSignatureHeader`) so the route reads
  the right one without knowing the vendor.
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

The SAME suite runs once per adapter (the publish script materializes each into
`adapters/selected/` and branches on `adapter.name`). `pg` is a
`conformance/package.json` test dep; the stripe adapter additionally installs the
`stripe` SDK, the paddle adapter installs nothing. Blocks A (DB-free) and B
(offline signature) always run; C (mirror/idempotency) needs
`PARTKIT_TEST_DATABASE_URL`. Block B's wire-format anchor differs per vendor: for
stripe it cross-checks our verifier against Stripe's own
`generateTestHeaderString`; for paddle (which publishes no signer) it pins a
known-answer vector. The paddle adapter additionally has **Block W** — its REST
write calls (customer/transaction/cancel/reactivate/change-plan) exercised
against a protocol-faithful fake Paddle server, no live creds needed. Block D
drives the real Stripe test API (stripe only); Paddle has no equivalent live
block because Paddle creates subscriptions only through hosted-checkout payment,
which can't be driven headlessly. Stripe: 27 tests green vs real Stripe + PG;
paddle: 32 tests green (incl. Block W writes + the mirror over real PG).

## Threat model

- **Forged webhooks / privilege escalation via fake "subscription active".**
  Mitigation: every inbound event is HMAC-verified over the raw bytes against
  `BILLING_WEBHOOK_SECRET` before any parse or write — Stripe's `t.rawBody` / `v1`
  scheme and Paddle's `ts:rawBody` / `h1` scheme, each timing-safe and tolerant of
  multiple signatures for key rotation. State is written only from verified
  events; the success redirect and client input grant nothing.
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
- ✅ A second vendor adapter (paddle) — shipped in 1.1.0; the attested vendor-flip
  is real. LemonSqueezy / others are interchangeable by construction against the
  same suite.
- Compose inbound verification on `webhooks.ingest` (v2) instead of the part's
  own verifier, once a shared multi-event-source story exists.
- Usage-based add-ons via `billing.usage` (sibling capability).
