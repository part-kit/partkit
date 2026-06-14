/**
 * The driver-free database seam — the same minimal `node-postgres` Client/Pool
 * shape `partkit migrate` uses. The app wires its own `pg` Pool to this; the
 * part imports no driver (contract invariant 7). Wiring example: seams.md §2.
 */
export interface SqlExecutor {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Record a metered usage event. FAST + LOCAL — never calls the biller inline. */
export interface RecordUsageInput {
  /** The billable principal — a customer/org id, OR an auth.apikey id. Opaque. */
  subjectId: string;
  /** Metric name, e.g. "api.request", "tokens.input". */
  meter: string;
  /** Units consumed — finite, >= 0. Integers round-trip exactly (seams.md §6). */
  quantity: number;
  /** Dedupe retries → exactly one ledger row (per subject+meter). */
  idempotencyKey?: string;
  /** Event time (default now); supports late/backfilled events landing in-period. */
  at?: Date;
  /** Arbitrary structured detail, stored as jsonb. */
  metadata?: Record<string, unknown>;
}

export interface RecordedUsage {
  /** The ledger event id — also the stable biller idempotency key. */
  eventId: string;
  /** true when an existing event with the same idempotencyKey was returned. */
  deduped: boolean;
}

export interface UsageTotalQuery {
  subjectId: string;
  meter: string;
  /** Inclusive lower bound on occurred_at. */
  since?: Date;
  /** Exclusive upper bound on occurred_at. */
  until?: Date;
}

export interface UsageSummaryQuery {
  subjectId: string;
  since?: Date;
  until?: Date;
}

export interface UsageTotal {
  subjectId: string;
  meter: string;
  /**
   * Summed quantity as a JS number. The DB total is always exact (NUMERIC); this
   * number can lose precision only for sums beyond 2^53 or many fine decimals —
   * see seams.md §6. The Stripe adapter reports the exact value, not this number.
   */
  quantity: number;
  /** Number of events in the window. */
  count: number;
}

export interface ReportDueOptions {
  /** Injected clock (defaults to the real now). */
  now?: Date;
  /** Max unreported rows to report this pass (default 100). */
  batch?: number;
}

export interface UsageReport {
  /** Events successfully reported and marked this pass. */
  reported: number;
  /** Events whose report failed; left unreported for the next pass. */
  failed: number;
}

export interface UsageMeter {
  record(input: RecordUsageInput): Promise<RecordedUsage>;
  total(query: UsageTotalQuery): Promise<UsageTotal>;
  summary(query: UsageSummaryQuery): Promise<UsageTotal[]>;
  reportDue(opts?: ReportDueOptions): Promise<UsageReport>;
}

/* ── adapter contract (the vendor seam) ───────────────────────────────────── */

/** One unreported ledger event handed to the biller adapter. */
export interface ReportableEvent {
  /** Stable ledger id — the adapter MUST use this as the biller idempotency key. */
  eventId: string;
  subjectId: string;
  meter: string;
  /** EXACT decimal string (never a rounded JS number) so billing stays byte-exact. */
  quantity: string;
  occurredAt: Date;
  metadata: Record<string, unknown>;
}

/**
 * A biller adapter. The zero-dep core never imports it directly — the selected
 * adapter is wired in by index.ts (`../adapters/selected/adapter`).
 */
export interface UsageAdapter {
  readonly name: string;
  /** Report one event to the biller. Idempotent on event.eventId. */
  report(event: ReportableEvent): Promise<{ reportedId?: string }>;
}
