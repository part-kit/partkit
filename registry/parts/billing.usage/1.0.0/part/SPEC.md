# billing.usage — design notes & threat model

`billing.usage` is the verified **metered-usage ledger**: record consumption
events idempotently into a part-owned table, aggregate per subject/meter/period,
and report unreported usage to a biller (Stripe Meters) out-of-band. The ledger
is vendor-neutral and the source of truth — invoice from it yourself or push to
Stripe; the biller is an adapter, not the foundation. It composes with
`auth.apikey` (the subject can be an API-key id) and `billing.subscription`
(hybrid plan + usage billing), with no `requires` edge on either.

Zero-dependency core (node:crypto + SQL); only the `stripe` adapter pulls a
dependency (`stripe`, per-adapter `npm_dependencies`, RFC 0001), so a
self-billing consumer ships no SDK on the metering path. Driver-free via the
`SqlExecutor` seam; owns `billing_usage_events`.

## Record is enqueue-only; reporting is out-of-band

`record` validates, writes one ledger row, and returns — it performs **no biller
call**. So a biller outage (or a slow Stripe) never blocks or fails the request
that is metering usage. The biller is touched only by `reportDue`, which is meant
to run on a schedule (under `jobs.queue` or a plain cron). The row carries its
own reporting state (`reported_at`), so `reportDue` is a self-contained drain and
the part owns the reporting lifecycle without depending on `jobs.queue`.

## Idempotency — exactly one row per logical event

`record` is `INSERT … ON CONFLICT (subject_id, meter, idempotency_key) DO NOTHING
RETURNING id`. A retried call with the same `idempotencyKey` records nothing new
and returns the original `eventId` with `deduped: true`. The unique scope is
`(subject, meter, key)` so one request can meter several meters with the same key
(e.g. a request id). A `NULL` key never conflicts (Postgres distinct-NULL
semantics), so keyless records are always distinct — the documented "no dedupe"
path. The public `eventId` is an app-assigned `ue_…` token, known at insert time,
which doubles as the biller idempotency key.

## Reporting — at-least-once, deduplicated by the biller (report-then-mark)

`reportDue` drains `reported_at IS NULL` rows (fewest-failures-then-oldest first),
reports each to the adapter using the stable `eventId` as the biller idempotency
key, then marks `reported_at` under a `WHERE reported_at IS NULL` one-way guard.
It **reports before marking**: if the process crashes after a successful report
but before the mark, the next pass re-reports the same `eventId` and the biller
dedupes.

The honest guarantee is **at-least-once toward the biller, exactly-once within
the biller's dedup window** — for Stripe Meters that window is the meter-event
`identifier`'s ≥24h uniqueness. In normal operation the next drain runs within
minutes, comfortably inside the window, so re-reports are deduped and effectively
exactly-once. The only way to double-bill is a report that succeeds, then a
mark/crash failure, then the row is **not** re-drained for longer than the dedup
window (a sustained multi-day reporting stall while the biller stayed up). The
ledger stays the source of truth; for absolute exactness, reconcile from it.

A per-event failure leaves the row unreported for the next pass (never dropped)
and increments `report_attempts`, which sinks the row in the drain order — so a
**permanently-rejected** event (e.g. a `subjectId` that maps to no biller
customer) can never head-of-line-block fresh usage. A `config` error (the biller
secret unset) aborts the pass and surfaces, rather than silently failing every
event. A no-adapter meter makes `reportDue` a no-op. Concurrent drains are safe.
A per-pass time budget plus a per-request biller timeout bound a single run.

### Late / backfilled events

`record` accepts `at` in the past for backfill. Stripe Meters rejects timestamps
older than ~35 days, so the adapter **clamps** the reported timestamp into
Stripe's window: a late event is reported into the **current** period (still
billed) rather than rejected and lost. If you need late usage billed in its
*original* period, invoice from the ledger directly (`total`/`summary`) rather
than via Stripe Meters.

## Quantity precision

`quantity` is `NUMERIC` — exact for integers (no float drift, contract invariant
5) and for decimals. node-postgres returns NUMERIC/bigint as strings, so
quantities are bound in as strings and aggregates come out as text, mapped back
through a guarded converter. The DB total is always exact; the JS `number`
returned to callers can lose precision only beyond 2^53 or across many fine
decimals (a JS-boundary limit). The Stripe adapter reports the **exact** stored
string, never the rounded JS double, so billing stays byte-exact.

## subjectId is opaque

The part does not own customers. `subjectId` is whatever principal the app meters
— a customer/org id, or an `auth.apikey` id for per-key metering (the composition
the AI-API skeleton wants). The Stripe adapter sends `subjectId` as the Stripe
customer id; if your subject is not already a customer id, you map it in your app
before recording. No `requires` edge to `auth.apikey` or `billing.subscription`.

## <a id="threat-model"></a>Threat model

| Threat | Mitigation |
|---|---|
| **Double-billing on retries** | `record` is idempotent on `(subject, meter, idempotencyKey)`; `reportDue` reports each event with its stable `eventId` as the biller's dedup `identifier`, so re-runs and concurrent drains are deduped within the biller's dedup window. (Beyond that window — a report-succeeds-then-stalls-for-days case — reporting degrades to at-least-once; reconcile from the ledger.) |
| **Lost / dropped usage** (a biller outage silently eats events) | Durable transactional ledger; `reportDue` reports-then-marks and leaves failures unreported for the next pass — events are never dropped, and the un-billed backlog is queryable (`reported_at IS NULL`). Late events are clamped into the biller's window so they bill rather than being rejected; a permanently-rejected event sinks in the drain order (by `report_attempts`) so it never blocks fresh usage. |
| **Slow / failing biller stalling the request** | `record` never calls the biller inline; reporting is out-of-band with a bounded per-pass budget and per-event isolation (one failure never aborts the batch). |
| **Inexact billing from float drift** | `NUMERIC` storage (exact for integers and decimals); the adapter reports the exact string, not a rounded JS number. |
| **SQL injection via subject/meter/metadata** | Constant statements, positional parameters only; every statement touches only `billing_usage_events`. |
| **Secret leakage** | The biller secret is read lazily, only in the adapter, and never appears in any `UsageError` message (every storage/vendor message is run through `redactSecrets`) or in any returned value. |
| **Cross-tenant aggregation error** | `total`/`summary` always filter by `subject_id` and use a half-open `[since, until)` window (since-inclusive, until-exclusive) so period boundaries never double-count or drop. |

### Out of scope (v1, see RFC 0005 §5)

Real-time quota enforcement (gate before allowing work), in-part price/tier
calculation, more biller adapters (Lago, OpenMeter, Metronome), and pre-aggregated
rollups for very high event volume are additive futures. v1 records, aggregates,
and reports raw quantities; pricing stays the biller's job.
