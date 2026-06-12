import { AuditError } from "./errors";
import type { AuditEventInput, AuditQuery } from "./types";

const MAX_FIELD = 256;
const MAX_METADATA_BYTES = 65_536;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

/** Normalized, validated form the SQL layer consumes for an append. */
export interface ValidatedEvent {
  actor: string | null;
  action: string;
  target: string | null;
  metadataJson: string;
}

/** Normalized, validated filter the SQL layer consumes for a query. */
export interface ValidatedQuery {
  actor: string | null;
  action: string | null;
  target: string | null;
  since: Date | null;
  until: Date | null;
  before: string | null;
  limit: number;
}

function invalidEvent(detail: string): AuditError {
  return new AuditError("invalid_event", detail);
}

function checkField(value: string, label: string): void {
  if (value.length > MAX_FIELD) {
    throw invalidEvent(`${label} exceeds ${MAX_FIELD} characters`);
  }
}

/**
 * Validate before any SQL: an invalid event fails fast with zero database
 * interaction (contract invariant 6). action is the one required field.
 */
export function validateEvent(event: AuditEventInput): ValidatedEvent {
  if (typeof event.action !== "string" || event.action.trim() === "") {
    throw invalidEvent("action is required and must be a non-empty string");
  }
  checkField(event.action, "action");

  const actor = event.actor ?? null;
  if (actor !== null) {
    if (typeof actor !== "string") throw invalidEvent("actor must be a string or null");
    checkField(actor, "actor");
  }
  const target = event.target ?? null;
  if (target !== null) {
    if (typeof target !== "string") throw invalidEvent("target must be a string or null");
    checkField(target, "target");
  }

  const metadata = event.metadata ?? {};
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw invalidEvent("metadata must be a plain object");
  }
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(metadata);
  } catch (e) {
    throw invalidEvent(`metadata is not JSON-serializable: ${e instanceof Error ? e.message : "?"}`);
  }
  // JSON.stringify yields undefined only for non-plain values already excluded above.
  if (metadataJson === undefined) throw invalidEvent("metadata is not JSON-serializable");
  if (Buffer.byteLength(metadataJson, "utf8") > MAX_METADATA_BYTES) {
    throw invalidEvent(`metadata exceeds ${MAX_METADATA_BYTES} bytes when serialized`);
  }

  return { actor, action: event.action, target, metadataJson };
}

function invalidQuery(detail: string): AuditError {
  return new AuditError("invalid_query", detail);
}

export function validateQuery(query: AuditQuery): ValidatedQuery {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) {
      throw invalidQuery(`limit must be an integer in 1..${MAX_LIMIT}, got ${String(query.limit)}`);
    }
    limit = query.limit;
  }

  for (const [k, v] of [
    ["actor", query.actor],
    ["action", query.action],
    ["target", query.target],
  ] as const) {
    if (v !== undefined && (typeof v !== "string" || v.length > MAX_FIELD)) {
      throw invalidQuery(`${k} filter must be a string of at most ${MAX_FIELD} characters`);
    }
  }

  if (query.since !== undefined && !(query.since instanceof Date)) {
    throw invalidQuery("since must be a Date");
  }
  if (query.until !== undefined && !(query.until instanceof Date)) {
    throw invalidQuery("until must be a Date");
  }
  // The cursor is an opaque id we minted; require digits so a hand-built value
  // can never be anything but a bigint literal.
  if (query.before !== undefined && !/^\d+$/.test(query.before)) {
    throw invalidQuery("before must be an event id (digits only)");
  }

  return {
    actor: query.actor ?? null,
    action: query.action ?? null,
    target: query.target ?? null,
    since: query.since ?? null,
    until: query.until ?? null,
    before: query.before ?? null,
    limit,
  };
}
