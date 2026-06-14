# Seams — billing.usage

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested interior;
edits void the attestation and fail CI).

## 1. The connection seam + one migration

This part owns one Postgres table, `billing_usage_events`, reached through a
connection you hand in. Import through your alias:

```jsonc
// tsconfig.json → compilerOptions (recommended alias)
"paths": { "@parts/*": ["./parts/*/src"] }
```

```ts
import { usage, UsageError } from "@parts/billing.usage";
```

Never deep-import `src/internal/**` (lint-enforced).

## 2. The connection seam (`SqlExecutor`)

The part is **driver-free** — it never imports `pg`. Give it the minimal executor
(the same shape `partkit migrate` uses); copy `examples/pg-executor.ts`:

```ts
const db: SqlExecutor = {
  query: (sql, params) => pool.query(sql, params ? [...params] : undefined),
};
const meter = usage(db);
```

## 3. Run the migration before first use

```sh
partkit migrate            # reads DATABASE_URL; records the _part_migrations ledger
```

The table is **interior** — never `SELECT`/`INSERT`/`UPDATE` it directly; read
and write only through the meter.

## 4. Record usage, read totals (the ledger — vendor-neutral)

```ts
const meter = usage(db);

// Record on the hot path: FAST + LOCAL, never calls the biller.
const { eventId, deduped } = await meter.record({
  subjectId: customer.id,        // your billable principal — opaque to the part
  meter: "tokens.input",         // your metric name
  quantity: 1240,                // finite, >= 0
  idempotencyKey: requestId,     // optional — a retry with the same key records once
  at: new Date(),                // optional — event time (supports backfill)
  metadata: { model: "x" },      // optional jsonb
});

// Aggregate for an invoice / usage page (half-open [since, until) window).
const t = await meter.total({ subjectId: customer.id, meter: "tokens.input", since: monthStart });
const lines = await meter.summary({ subjectId: customer.id, since: monthStart });
```

`idempotencyKey` dedupes **per (subject, meter)**, so one request can record
several meters with the same key (e.g. a request id) without collision. Omit it
and every call is a distinct event.

## 5. Report to a biller — `reportDue` (the composition seam)

The ledger is the source of truth; you can **invoice from it yourself** and never
call `reportDue`. To push usage to Stripe Meters, drain the unreported events on
a schedule. `reportDue` owns its own drain state, so a cron or `jobs.queue` is
just a clock — no `requires` edge.

```ts
// production: a jobs.queue cron item, or a plain platform cron — see examples/report-wiring.ts
await usage(db).reportDue({ batch: 500 });
```

- **The Stripe adapter sends `subjectId` as the Stripe customer id**
  (`stripe_customer_id`). So when you intend to report to Stripe, use the Stripe
  customer id as your `subjectId` — or keep your own mapping and record with the
  customer id (e.g. when your subject is an `auth.apikey` id, resolve it to the
  customer when you record). The meter's `event_name` must equal the `meter` you
  record (a short identifier — `meter` is capped at 100 chars); create the Stripe
  meter once with `default_aggregation: { formula: "sum" }`.
- **Env:** the Stripe adapter reads `BILLING_USAGE_SECRET_KEY` (your Stripe
  secret key) lazily, only when `reportDue` actually reports. The ledger
  (record/total/summary) needs no env. A missing key makes `reportDue` throw a
  `config` error (it does not silently fail every event).
- **At-least-once, deduped by the biller:** each event is reported with its
  stable `eventId` as Stripe's meter-event `identifier`, so a re-run is deduped
  **within Stripe's dedup window (≥24h)** — effectively exactly-once in normal
  operation. A failed report leaves the event unreported for the next pass —
  never dropped — and a permanently-rejected event sinks in the drain order so it
  never blocks fresh usage. Run **one** drain at a time; concurrent drains are
  safe. For absolute exactness across a multi-day reporting stall, reconcile from
  the ledger.
- **Late / backfilled events:** Stripe rejects timestamps older than ~35 days, so
  the adapter clamps a late event into the current period (it still bills). If you
  need late usage billed in its *original* period, invoice from the ledger (§4)
  instead of via Stripe Meters.

## 6. Quantity precision (read this if you bill on decimals)

`quantity` is stored as Postgres `NUMERIC` — **exact** for integers (no float
drift) and for decimals. The DB total is always exact. The `UsageTotal.quantity`
you read back is a JS `number`, which can only lose precision for sums beyond
2^53 (≈9e15) or many fine-grained decimals — that's a JS-boundary limit, not a
storage one. The Stripe adapter reports the **exact** stored value, not the
rounded JS number, so billing stays byte-exact. For exact display of very large
or high-precision sums, aggregate in SQL rather than summing JS numbers.

## 7. Error handling

Every failure is a `UsageError` with `.code`:

| code | meaning | typical HTTP |
|---|---|---|
| `invalid_input` | bad arguments (blank subject/meter, non-finite or negative quantity, bad batch) | 400 |
| `config` | the biller secret (`BILLING_USAGE_SECRET_KEY`) is missing when `reportDue` runs | 500 |
| `vendor` | the biller (Stripe) rejected a report (surfaced per-event; the event stays unreported) | 502 |
| `storage` | the executor (database) failed. The message is generic and secret-redacted. | 500 |

## 8. What you must NOT do

- Edit or import anything under `src/internal/**`.
- `SELECT`/`INSERT`/`UPDATE` `billing_usage_events` directly — use the meter.
- Call the biller yourself / report inline — recording is local; reporting is
  out-of-band via `reportDue`.
- Run many `reportDue` workers expecting exactly-once — it's at-least-once toward
  the biller, which dedupes on the event id.
- Sum `UsageTotal.quantity` JS numbers for exact billing of huge/high-precision
  totals — aggregate in SQL (see §6).
