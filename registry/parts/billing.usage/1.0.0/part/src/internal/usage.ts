import { redactSecrets } from "./config";
import { UsageError } from "./errors";
import { newEventId } from "./ids";
import {
  BUMP_ATTEMPT_SQL,
  INSERT_EVENT_SQL,
  MARK_REPORTED_SQL,
  quantityToNumber,
  RESOLVE_BY_IDEM_SQL,
  rowToReportable,
  SELECT_UNREPORTED_SQL,
  SUMMARY_SQL,
  TOTAL_SQL,
} from "./sql";
import type {
  RecordedUsage,
  RecordUsageInput,
  ReportDueOptions,
  SqlExecutor,
  UsageAdapter,
  UsageMeter,
  UsageReport,
  UsageSummaryQuery,
  UsageTotal,
  UsageTotalQuery,
} from "./types";
import { validateRecord, validateSummaryQuery, validateTotalQuery } from "./validate";

const DEFAULT_BATCH = 100;
const MAX_BATCH = 1000;
// Cap summary cardinality so a subject with pathologically many distinct meters
// can't return an unbounded array (a sane invoice has far fewer meters).
const MAX_SUMMARY_METERS = 1000;
// Bound a single reporting pass so a backlog can't make one pass run unboundedly;
// remaining unreported rows are picked up by the next pass.
const MAX_PASS_MS = 30_000;

function storageFail(msg: string): UsageError {
  return new UsageError("storage", msg);
}

/** Bind the usage meter to a database connection and the selected biller adapter. */
export function makeUsage(db: SqlExecutor, adapter: UsageAdapter | null): UsageMeter {
  async function q(
    sql: string,
    params: readonly unknown[],
    action: string,
  ): Promise<{ rows: Record<string, unknown>[] }> {
    try {
      return await db.query(sql, params);
    } catch (e) {
      // Generic + secret-redacted message (contract invariant 6).
      throw storageFail(redactSecrets(`failed to ${action}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  async function record(input: RecordUsageInput): Promise<RecordedUsage> {
    const v = validateRecord(input); // throws invalid_input before any SQL; NEVER calls the biller
    const id = newEventId();
    const ins = await q(
      INSERT_EVENT_SQL,
      [id, v.subjectId, v.meter, v.quantityText, v.at, v.idempotencyKey, v.metadataJson],
      "record usage",
    );
    const insertedId = ins.rows[0]?.["id"];
    if (insertedId !== undefined) return { eventId: String(insertedId), deduped: false };

    // Empty RETURNING ⟹ an idempotency conflict (a NULL key never conflicts).
    if (v.idempotencyKey !== null) {
      const existing = await q(
        RESOLVE_BY_IDEM_SQL,
        [v.subjectId, v.meter, v.idempotencyKey],
        "record usage",
      );
      const row = existing.rows[0];
      if (row !== undefined) return { eventId: String(row["id"]), deduped: true };
    }
    throw storageFail("record did not persist — is the billing_usage migration applied?");
  }

  async function total(query: UsageTotalQuery): Promise<UsageTotal> {
    const v = validateTotalQuery(query);
    const res = await q(TOTAL_SQL, [v.subjectId, v.meter, v.since, v.until], "aggregate usage total");
    const row = res.rows[0] ?? {};
    return {
      subjectId: v.subjectId,
      meter: v.meter,
      quantity: quantityToNumber(row["quantity"], storageFail),
      count: Number(row["count"] ?? 0),
    };
  }

  async function summary(query: UsageSummaryQuery): Promise<UsageTotal[]> {
    const v = validateSummaryQuery(query);
    const res = await q(SUMMARY_SQL, [v.subjectId, v.since, v.until, MAX_SUMMARY_METERS], "aggregate usage summary");
    return res.rows.map((row) => ({
      subjectId: v.subjectId,
      meter: String(row["meter"]),
      quantity: quantityToNumber(row["quantity"], storageFail),
      count: Number(row["count"] ?? 0),
    }));
  }

  async function reportDue(opts?: ReportDueOptions): Promise<UsageReport> {
    if (adapter === null) return { reported: 0, failed: 0 }; // ledger-only: nothing to report
    const now = opts?.now ?? new Date();
    const batch = opts?.batch ?? DEFAULT_BATCH;
    if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) {
      throw new UsageError("invalid_input", `batch must be an integer in 1..${MAX_BATCH}`);
    }
    const due = await q(SELECT_UNREPORTED_SQL, [batch], "select unreported usage");
    let reported = 0;
    let failed = 0;
    const passStart = Date.now();
    for (const raw of due.rows) {
      if (Date.now() - passStart > MAX_PASS_MS) break;
      const event = rowToReportable(raw);
      try {
        // Idempotency toward the biller IS the stable eventId — a re-run after a
        // partial failure re-sends the same key, so the biller dedupes; never
        // double-billed. Report BEFORE marking, so a crash re-reports (dedup),
        // never drops (contract invariant 4).
        // eslint-disable-next-line no-await-in-loop
        const result = await adapter.report(event);
        // eslint-disable-next-line no-await-in-loop
        await q(MARK_REPORTED_SQL, [event.eventId, now, result.reportedId ?? null], "mark usage reported");
        reported += 1;
      } catch (e) {
        // A config error (e.g. the biller secret is unset) is a fatal pass-wide
        // misconfiguration, not a per-event failure — surface it so an operator
        // sees it, instead of silently failing every event forever.
        if (e instanceof UsageError && e.code === "config") throw e;
        // Otherwise: leave reported_at NULL → next pass retries (never dropped),
        // and bump the failure count so a permanently-rejected event sinks in the
        // drain order and can't starve fresh usage. One bad event never aborts.
        failed += 1;
        try {
          // eslint-disable-next-line no-await-in-loop
          await q(BUMP_ATTEMPT_SQL, [event.eventId], "record report attempt");
        } catch {
          /* best-effort — a failed bump must not abort the batch */
        }
      }
    }
    return { reported, failed };
  }

  return { record, total, summary, reportDue };
}
