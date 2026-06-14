# Seams — webhooks.dispatch

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested interior;
edits void the attestation and fail CI).

## 1. No env, no adapter — a connection seam + one migration

This part reads **no env vars** and ships **no registry adapters**. It owns
three Postgres tables (`webhooks_dispatch_endpoints`, `…_outbox`, `…_attempts`)
and reaches them through a connection you hand in. Import through your alias:

```jsonc
// tsconfig.json → compilerOptions (recommended alias)
"paths": { "@parts/*": ["./parts/*/src"] }
```

```ts
import { dispatcher, DispatchError } from "@parts/webhooks.dispatch";
```

Never deep-import `src/internal/**` (lint-enforced). Node 22+.

## 2. The connection seam (`SqlExecutor`)

The part is **driver-free** — it never imports `pg`. Give it the minimal
executor (the same shape `partkit migrate` uses); copy `examples/pg-executor.ts`:

```ts
const db: SqlExecutor = {
  query: (sql, params) => pool.query(sql, params ? [...params] : undefined),
};
const wh = dispatcher(db);
```

## 3. Run the migration before first use

```sh
partkit migrate            # reads DATABASE_URL; records the _part_migrations ledger
```

The tables are **interior** — never `SELECT`/`INSERT`/`UPDATE` them directly;
read and write only through the dispatcher. **The `endpoints.secret` column is a
credential** (outbound signing is symmetric HMAC, so the part must store the
secret to sign each delivery). Protect this database as you would any secret
store; it is the one place the signing secret lives after registration.

## 4. Register endpoints and dispatch events

```ts
const wh = dispatcher(db);

// Register a customer destination. The secret is returned ONCE — show it to the
// customer so they can verify your deliveries, then forget it.
const { id, secret } = await wh.registerEndpoint({
  ownerId: customer.id,          // your principal — opaque to the part
  url: "https://customer.example/webhooks",  // https + public address only (§6)
  eventTypes: ["invoice.paid"],  // informational in v1; omit for "all"
});

// Enqueue an event. Returns immediately — NEVER delivers inline, so a slow or
// hostile customer endpoint can't block or fail the request that triggered it.
const { messageId } = await wh.dispatch({
  endpointId: id,
  eventType: "invoice.paid",
  payload: { invoiceId: "in_123", amount: 4200 }, // JSON-serializable
  idempotencyKey: "invoice.paid:in_123",          // optional — dedupes re-enqueues
});
```

Each delivery is signed with **Standard Webhooks** headers (`webhook-id`,
`webhook-timestamp`, `webhook-signature`) — byte-identical to what
`webhooks.ingest`'s `standardwebhooks` adapter verifies. Your customer verifies
with the `secret` and the same code.

## 5. Deliver out-of-band — `deliverDue` (the composition seam)

`dispatch` only enqueues. Something must drain the outbox by calling
`deliverDue()` on a schedule. It is a self-contained drainer: it picks due rows,
signs, POSTs, and on failure records the attempt and reschedules with capped
exponential backoff — the part owns retry/backoff/dead-letter, so you do **not**
need `jobs.queue`.

**Production path — under `jobs.queue`** (a clock, not a retry engine):

```ts
// your task map (jobs.queue seam)
export const tasks: TaskHandlers = {
  deliver_due_webhooks: async () => { await dispatcher(db).deliverDue({ batch: 100 }); },
};
// server daemon: fire it on a cron pattern
await runWorker({ connectionString, tasks, cron: [{ task: "deliver_due_webhooks", pattern: "* * * * *" }] });
// serverless: point the platform cron at a guarded route that calls deliverDue directly
```

**Standalone path — a plain cron** (no `jobs.queue` at all):

```ts
// scripts/deliver-webhooks.ts — invoked by an OS/platform cron every minute
await dispatcher(db).deliverDue();
```

See `examples/jobs-wiring.ts`. Run **one** drain at a time (the cron fires one).
Concurrent drains are safe but may double-deliver (at-least-once) — your customer
dedupes on the stable `webhook-id`.

## 6. SSRF & delivery semantics

- **Destinations must be `https://` and public.** `registerEndpoint` and every
  delivery refuse loopback, link-local, RFC-1918, unique-local IPv6, and the
  cloud metadata address `169.254.169.254`. The delivery check runs on the
  **DNS-resolved IP at send time**, so a host that rebinds to a private address
  after registration is still refused.
- **Retry policy:** network error / `5xx` / `429` retry with capped exponential
  backoff (honoring `Retry-After`) up to a bounded attempt count, then
  **dead-letter** (`status = 'dead'`, never dropped). A `4xx` other than `429` is
  **permanent** — not retried. Read the full log with `listAttempts(messageId)`.
- **Receiver-side dedupe:** retries re-sign with a fresh timestamp but keep the
  stable `webhook-id`; tell your customers to dedupe on it (at-least-once).

## 7. Error handling

Every failure is a `DispatchError` with `.code`:

| code | meaning | typical HTTP |
|---|---|---|
| `invalid_url` | not https, malformed, or a non-public (SSRF) destination | 400 |
| `unknown_endpoint` | `dispatch` referenced an endpoint id that doesn't exist | 404 |
| `invalid_payload` | payload not JSON-serializable, or other malformed input | 400 |
| `storage` | the executor (database) failed. Raw driver error is on `.cause` (may contain credentials — don't log blindly); `.message` is generic. | 500 |

## 8. What you must NOT do

- Edit or import anything under `src/internal/**`.
- `SELECT`/`INSERT`/`UPDATE` the `webhooks_dispatch_*` tables directly.
- Deliver webhooks yourself / call `dispatch` and then POST inline — the whole
  point is that delivery is out-of-band and retried.
- Expose `endpoints.secret` anywhere after registration, or log a
  `DispatchError.cause` without scrubbing it.
- Run many `deliverDue` workers expecting exactly-once — it's at-least-once.
