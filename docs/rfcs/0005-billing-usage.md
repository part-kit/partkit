# RFC 0005 — `billing.usage` capability

**Status:** accepted 2026-06-14 (chief-architect session; capability already in the docs/02 namespace, this RFC specifies its interface)
**Adds capability:** `billing.usage@1`
**Unblocks:** the AI-app / API-product skeleton (App Pack `ai-api`) — the last of the Wave 2 trio after `auth.apikey` and `webhooks.dispatch`
**Composes with:** `auth.apikey` (the metered subject can be an API-key id), `billing.subscription` (hybrid plan + usage billing); independent of both (no `requires` edge)
**Author:** chief-architect session, 2026-06-14

## 1. Problem

API and AI products bill by **consumption** — requests, input/output tokens,
GB stored, minutes transcribed. Hand-rolled metering is where the money quietly
goes wrong: events double-counted on retries (no idempotency), lost on a crash
(no durable ledger), mis-aggregated across billing periods, and the whole product
welded to one biller's SDK so you can never move or self-host. The failure is
invisible until a customer disputes an invoice.

`billing.usage` is the verified usage ledger: **record** metered events
idempotently into a part-owned table, **aggregate** per subject/meter/period, and
**report** unreported usage to a biller (Stripe Meters) out-of-band. The ledger is
vendor-neutral and the source of truth — you can invoice from it yourself or push
to Stripe; the biller is an adapter, not the foundation.

## 2. Interface (`billing.usage@1`)

```ts
usage(db: SqlExecutor): UsageMeter

interface UsageMeter {
  // Record a usage event. FAST + LOCAL — never calls the biller inline.
  // Idempotent: the same idempotencyKey records exactly one event.
  record(input: {
    subjectId: string;            // the billable principal — a customer/org id, OR an auth.apikey id
    meter: string;                // metric name, e.g. "api.request", "tokens.input"
    quantity: number;             // units consumed (finite, >= 0)
    idempotencyKey?: string;      // dedupe retries → exactly one ledger row
    at?: Date;                    // event time (default now); supports late/backfilled events
    metadata?: Record<string, unknown>;
  }): Promise<{ eventId: string; deduped: boolean }>;

  // Aggregate a single subject+meter over [since, until). The numbers you bill / show.
  total(query: { subjectId: string; meter: string; since?: Date; until?: Date }): Promise<UsageTotal>;

  // Per-meter breakdown for a subject (an invoice line set / usage dashboard).
  summary(query: { subjectId: string; since?: Date; until?: Date }): Promise<UsageTotal[]>;

  // Report unreported events to the configured biller adapter, idempotently, and
  // mark them reported. Designed to run under jobs.queue or a cron, like
  // webhooks.dispatch.deliverDue. A no-op if no adapter is selected.
  reportDue(opts?: { now?: Date; batch?: number }): Promise<UsageReport>;
}

interface UsageTotal { subjectId: string; meter: string; quantity: number; count: number }
interface UsageReport { reported: number; failed: number }
class UsageError extends Error { code: "invalid_input" | "vendor" | "storage" }
```

Owns table `billing_usage_events` (forward-only migrations, `partkit migrate`).
**Adapter axis:** `stripe` (Stripe Meters) — per-adapter `npm_dependencies`
(RFC 0001), attested in the isolated harness against the real Stripe test API.

## 3. Invariants (each maps to ≥1 conformance test)

1. Importing performs no I/O and never throws; `record`/`total`/`summary` validate input with typed errors, and **`record` never calls the biller inline** — it only writes the local ledger, so a biller outage never blocks or fails metering.
2. **`record` is idempotent:** the same `idempotencyKey` (per subject+meter) yields exactly one ledger row; the second call returns `deduped: true` with the original `eventId`. `quantity` must be finite and ≥ 0; a non-finite/negative quantity is rejected before any SQL.
3. `total` and `summary` aggregate correctly over the `[since, until)` half-open window (since-inclusive, until-exclusive), honor the subject/meter filters, and are deterministic; an empty range yields a zero total, not an error.
4. **Reporting is exactly-once per event toward the biller:** `reportDue` reports each unreported event using its stable `eventId` as the biller's idempotency key, then marks it reported; a biller failure leaves the event unreported for the next pass — **never double-billed, never silently dropped.**
5. Quantities round-trip exactly for integer units (no float drift); decimal handling is documented in seams.md.
6. The biller secret never appears in error messages, in `UsageError`, or in any value the part returns.
7. The part operates solely through the provided `SqlExecutor` seam (it imports no database driver), every statement targets only its own `billing_usage_events` table, and every input is parameterized.

## 4. Implementation notes for the part author

- **Zero-dependency core:** the ledger (`record`/`total`/`summary`) is `node:crypto`
  + SQL only. Only the `stripe` adapter pulls a dependency (`stripe`, per-adapter
  `npm_dependencies`), so a self-billing consumer who never calls `reportDue` ships
  no vendor SDK on the metering path.
- **Reporting mirrors `webhooks.dispatch`:** `reportDue` is a self-contained
  outbox-style drainer over the ledger's `reported_at IS NULL` rows — it composes
  with `jobs.queue` (a clock) or a plain cron, with no `requires` edge. Idempotency
  toward Stripe is the `eventId` used as the meter-event idempotency key, so a
  re-run after a partial failure never double-reports.
- **Conformance** (the `audit.log` + `billing.subscription` patterns): ledger
  idempotency/aggregation/injection against real Postgres (gated on
  `PARTKIT_TEST_DATABASE_URL`), validation + typed errors DB-free, and the `stripe`
  adapter's reporting against the **real Stripe test API** (gated on the Stripe test
  key, like `billing.subscription`) — recording meter events and reading the meter
  back, plus a fake recorder for the DB-gated reporting-state invariants.
- **`subjectId` is opaque** — the part does not own customers. It is whatever
  principal the app meters: an `auth.apikey` id for per-key metering (the
  composition the AI-API skeleton wants), or a customer/org id. The Stripe adapter
  maps `subjectId` to the Stripe customer (or a meter-event customer mapping the app
  configures via a seam).

## 5. Roadmap (not v1)

- Real-time quota enforcement (`checkQuota(subject, meter, limit)` before allowing work) — v1 is record-then-aggregate, not a gate.
- In-part price calculation (tiers/graduated pricing) — v1 reports quantities; pricing stays the biller's job.
- More biller adapters (Lago, OpenMeter, Metronome) behind the same contract.
- Pre-aggregated rollups for very high event volume.

## Amendment — reporting guarantee & late events (2026-06-14, with `billing.usage@1.0.0`)

An adversarial review refined §3.4's "exactly-once / never double-billed" into the
honest, shipped guarantee: **at-least-once toward the biller, exactly-once within
the biller's dedup window.** A non-transactional biller call cannot be atomic with
the local mark, so the stable `eventId` (the biller's idempotency `identifier`) is
the dedup. In normal operation the next drain runs well inside the window
(effectively exactly-once); it degrades to at-least-once only if a report succeeds,
its mark fails, and the row is not re-drained for longer than the window — for
absolute exactness, reconcile from the ledger. Two related hardenings shipped:
(a) the adapter **clamps** an event timestamp into the biller's accepted window
(Stripe rejects >35-day-old events) so late/backfilled usage is billed into the
current period rather than rejected and lost; and (b) the drain orders by a
`report_attempts` counter so a permanently-rejected event sinks and never
head-of-line-blocks fresh usage. The contract/SPEC/seams wording matches this.
