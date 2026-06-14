import { UsageError } from "./errors";
import type { RecordUsageInput, UsageSummaryQuery, UsageTotalQuery } from "./types";

const MAX_FIELD = 512;
// A metric name is a short identifier; cap it well under any biller's event-name
// limit so an over-long meter can never become a permanently-unreportable row.
const MAX_METER = 100;
const MAX_METADATA_BYTES = 65_536;

function invalid(detail: string): UsageError {
  return new UsageError("invalid_input", detail);
}

export interface ValidatedRecord {
  subjectId: string;
  meter: string;
  quantityText: string;
  at: Date | null;
  idempotencyKey: string | null;
  metadataJson: string;
}

/** Validate before any SQL: a bad argument fails fast with zero database work. */
export function validateRecord(input: RecordUsageInput): ValidatedRecord {
  if (input === null || typeof input !== "object") throw invalid("record requires an input object");

  if (typeof input.subjectId !== "string" || input.subjectId.trim() === "") {
    throw invalid("subjectId is required and must be a non-empty string");
  }
  if (input.subjectId.length > MAX_FIELD) throw invalid(`subjectId exceeds ${MAX_FIELD} characters`);

  if (typeof input.meter !== "string" || input.meter.trim() === "") {
    throw invalid("meter is required and must be a non-empty string");
  }
  if (input.meter.length > MAX_METER) throw invalid(`meter exceeds ${MAX_METER} characters`);

  if (typeof input.quantity !== "number" || !Number.isFinite(input.quantity) || input.quantity < 0) {
    throw invalid("quantity must be a finite number >= 0");
  }

  let at: Date | null = null;
  if (input.at !== undefined && input.at !== null) {
    if (!(input.at instanceof Date) || Number.isNaN(input.at.getTime())) {
      throw invalid("at must be a valid Date");
    }
    at = input.at;
  }

  let idempotencyKey: string | null = null;
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim() === "") {
      throw invalid("idempotencyKey must be a non-empty string when provided");
    }
    if (input.idempotencyKey.length > MAX_FIELD) throw invalid("idempotencyKey is too long");
    idempotencyKey = input.idempotencyKey;
  }

  const metadata = input.metadata ?? {};
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw invalid("metadata must be a plain object");
  }
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(metadata);
  } catch (e) {
    throw invalid(`metadata is not JSON-serializable: ${e instanceof Error ? e.message : "?"}`);
  }
  if (metadataJson === undefined) throw invalid("metadata is not JSON-serializable");
  if (Buffer.byteLength(metadataJson, "utf8") > MAX_METADATA_BYTES) {
    throw invalid(`metadata exceeds ${MAX_METADATA_BYTES} bytes when serialized`);
  }

  // Bind quantity as a STRING to $n::numeric so integers/short decimals store exactly.
  return { subjectId: input.subjectId, meter: input.meter, quantityText: String(input.quantity), at, idempotencyKey, metadataJson };
}

function checkWindow(since: unknown, until: unknown): { since: Date | null; until: Date | null } {
  let s: Date | null = null;
  let u: Date | null = null;
  if (since !== undefined && since !== null) {
    if (!(since instanceof Date) || Number.isNaN(since.getTime())) throw invalid("since must be a Date");
    s = since;
  }
  if (until !== undefined && until !== null) {
    if (!(until instanceof Date) || Number.isNaN(until.getTime())) throw invalid("until must be a Date");
    u = until;
  }
  return { since: s, until: u };
}

export interface ValidatedTotalQuery {
  subjectId: string;
  meter: string;
  since: Date | null;
  until: Date | null;
}

export function validateTotalQuery(query: UsageTotalQuery): ValidatedTotalQuery {
  if (query === null || typeof query !== "object") throw invalid("total requires a query object");
  if (typeof query.subjectId !== "string" || query.subjectId.trim() === "") {
    throw invalid("subjectId is required and must be a non-empty string");
  }
  if (typeof query.meter !== "string" || query.meter.trim() === "") {
    throw invalid("meter is required and must be a non-empty string");
  }
  const { since, until } = checkWindow(query.since, query.until);
  return { subjectId: query.subjectId, meter: query.meter, since, until };
}

export interface ValidatedSummaryQuery {
  subjectId: string;
  since: Date | null;
  until: Date | null;
}

export function validateSummaryQuery(query: UsageSummaryQuery): ValidatedSummaryQuery {
  if (query === null || typeof query !== "object") throw invalid("summary requires a query object");
  if (typeof query.subjectId !== "string" || query.subjectId.trim() === "") {
    throw invalid("subjectId is required and must be a non-empty string");
  }
  const { since, until } = checkWindow(query.since, query.until);
  return { subjectId: query.subjectId, since, until };
}
