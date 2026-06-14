import { SearchError } from "./errors";
import type { IndexDocInput, SearchQuery } from "./types";

const MAX_REF = 512;
const MAX_TYPE = 256;
const MAX_TITLE = 2_000;
const MAX_BODY = 1_000_000; // 1 MB of text
const MAX_Q = 1_000;
const MAX_METADATA_BYTES = 65_536;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// A deep offset forces Postgres to rank-sort the entire match set (spilling to
// disk) before discarding the skipped rows — an amplifier with no legitimate UI
// use. Past a few pages, keyset/cursor pagination is the right tool.
const MAX_OFFSET = 10_000;

function invalid(detail: string): SearchError {
  return new SearchError("invalid_input", detail);
}

/**
 * Postgres rejects a U+0000 NUL in any text/jsonb param at the encoding layer
 * (SQLSTATE 22021/22P05) BEFORE websearch_to_tsquery ever parses it — so a NUL
 * in the raw query would surface as a storage/500, breaking the "never throws on
 * raw input" invariant. Reject it as invalid_input up front, on every string we
 * bind, so the query path fails fast (or returns []) instead of a 500.
 */
function rejectNul(value: string, field: string): void {
  if (value.includes("\u0000")) throw invalid(`${field} must not contain NUL (U+0000) bytes`);
}

/** Deep-scan a JSON-able value for a NUL in any string key or value. JSON.stringify
 *  turns a NUL into a `\u0000` escape that Postgres jsonb rejects (22P05), so a NUL
 *  buried in metadata must be caught here, before it surfaces as a storage/500. */
function hasNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(hasNul);
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.includes("\u0000") || hasNul(v)) return true;
    }
  }
  return false;
}

export interface ValidatedDoc {
  ref: string;
  type: string | null;
  title: string | null;
  body: string;
  metadataJson: string;
}

export function validateIndexDoc(input: IndexDocInput): ValidatedDoc {
  if (input === null || typeof input !== "object") throw invalid("index requires a document object");
  if (typeof input.ref !== "string" || input.ref.trim() === "") {
    throw invalid("ref is required and must be a non-empty string");
  }
  if (input.ref.length > MAX_REF) throw invalid(`ref exceeds ${MAX_REF} characters`);
  rejectNul(input.ref, "ref");
  if (typeof input.body !== "string" || input.body.trim() === "") {
    throw invalid("body is required and must be a non-empty string");
  }
  if (input.body.length > MAX_BODY) throw invalid(`body exceeds ${MAX_BODY} characters`);
  rejectNul(input.body, "body");

  let type: string | null = null;
  if (input.type !== undefined && input.type !== null) {
    if (typeof input.type !== "string") throw invalid("type must be a string");
    if (input.type.length > MAX_TYPE) throw invalid(`type exceeds ${MAX_TYPE} characters`);
    rejectNul(input.type, "type");
    type = input.type;
  }
  let title: string | null = null;
  if (input.title !== undefined && input.title !== null) {
    if (typeof input.title !== "string") throw invalid("title must be a string");
    if (input.title.length > MAX_TITLE) throw invalid(`title exceeds ${MAX_TITLE} characters`);
    rejectNul(input.title, "title");
    title = input.title;
  }

  const metadata = input.metadata ?? {};
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw invalid("metadata must be a plain object");
  }
  if (hasNul(metadata)) throw invalid("metadata must not contain NUL (U+0000) bytes in any string");
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

  return { ref: input.ref, type, title, body: input.body, metadataJson };
}

export function validateRef(ref: unknown): string {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw invalid("ref is required and must be a non-empty string");
  }
  if (ref.length > MAX_REF) throw invalid(`ref exceeds ${MAX_REF} characters`);
  rejectNul(ref, "ref");
  return ref;
}

export interface ValidatedQuery {
  q: string;
  type: string | null;
  limit: number;
  offset: number;
}

export function validateQuery(input: SearchQuery): ValidatedQuery {
  if (input === null || typeof input !== "object") throw invalid("query requires an input object");
  if (typeof input.q !== "string") throw invalid("q is required and must be a string");
  if (input.q.length > MAX_Q) throw invalid(`q exceeds ${MAX_Q} characters`);
  rejectNul(input.q, "q");

  let type: string | null = null;
  if (input.type !== undefined && input.type !== null) {
    if (typeof input.type !== "string") throw invalid("type must be a string");
    if (input.type.length > MAX_TYPE) throw invalid(`type exceeds ${MAX_TYPE} characters`);
    type = input.type;
  }

  let limit = DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT) {
      throw invalid(`limit must be an integer in 1..${MAX_LIMIT}`);
    }
    limit = input.limit;
  }
  let offset = 0;
  if (input.offset !== undefined) {
    if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > MAX_OFFSET) {
      throw invalid(`offset must be an integer in 0..${MAX_OFFSET}`);
    }
    offset = input.offset;
  }

  return { q: input.q, type, limit, offset };
}
