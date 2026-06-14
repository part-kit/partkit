import { ApiKeyError } from "./errors";
import type { IssueKeyInput } from "./types";

const MAX_OWNER = 256;
const MAX_NAME = 256;
const MAX_SCOPE = 256;
const MAX_SCOPES = 64;
export const MAX_GRACE_SECONDS = 30 * 86_400; // 30 days — a bounded window (invariant 6)

function invalid(detail: string): ApiKeyError {
  return new ApiKeyError("invalid_input", detail);
}

/** Normalized, validated input the store layer consumes for issue/rotate. */
export interface ValidatedIssue {
  ownerId: string;
  name: string | null;
  scopes: string[];
  expiresAt: Date | null;
}

/**
 * Validate before any SQL: a bad argument fails fast with a typed error and
 * issues zero database work (contract invariant 1). Scopes are de-duplicated and
 * order-normalized so storage is canonical; their MEANING is the app's, only
 * their shape is checked here.
 */
export function validateIssue(input: IssueKeyInput): ValidatedIssue {
  if (input === null || typeof input !== "object") {
    throw invalid("issueKey requires an input object");
  }
  if (typeof input.ownerId !== "string" || input.ownerId.trim() === "") {
    throw invalid("ownerId is required and must be a non-empty string");
  }
  if (input.ownerId.length > MAX_OWNER) {
    throw invalid(`ownerId exceeds ${MAX_OWNER} characters`);
  }

  let name: string | null = null;
  if (input.name !== undefined && input.name !== null) {
    if (typeof input.name !== "string") throw invalid("name must be a string");
    if (input.name.length > MAX_NAME) throw invalid(`name exceeds ${MAX_NAME} characters`);
    name = input.name;
  }

  const scopes = validateScopes(input.scopes);

  let expiresAt: Date | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
      throw invalid("expiresAt must be a valid Date or null");
    }
    expiresAt = input.expiresAt;
  }

  return { ownerId: input.ownerId, name, scopes, expiresAt };
}

/** Validate a scope list (from issue or from requireScopes); returns canonical form. */
export function validateScopes(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid("scopes must be an array of strings");
  if (raw.length > MAX_SCOPES) throw invalid(`a key may not have more than ${MAX_SCOPES} scopes`);
  const seen = new Set<string>();
  for (const s of raw) {
    if (typeof s !== "string" || s.trim() === "") {
      throw invalid("each scope must be a non-empty string");
    }
    if (s.length > MAX_SCOPE) throw invalid(`a scope exceeds ${MAX_SCOPE} characters`);
    seen.add(s);
  }
  return [...seen].sort();
}

/** Validate the optional rotation grace window. */
export function validateGraceSeconds(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_GRACE_SECONDS) {
    throw invalid(`graceSeconds must be an integer in 0..${MAX_GRACE_SECONDS}`);
  }
  return raw;
}

/**
 * A management id is an issued prefix ("ak" + base62). Validating its shape here
 * means a junk id fails fast as invalid_input and never reaches the database.
 */
const ID_RE = /^ak[0-9A-Za-z]{1,62}$/;
export function validateId(id: unknown): string {
  if (typeof id !== "string" || id.trim() === "") {
    throw invalid("a key id is required and must be a non-empty string");
  }
  if (!ID_RE.test(id)) throw invalid("not a valid key id");
  return id;
}

/** An ownerId for listKeys — required, bounded, non-empty. */
export function validateOwnerId(ownerId: unknown): string {
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    throw invalid("ownerId is required and must be a non-empty string");
  }
  if (ownerId.length > MAX_OWNER) throw invalid(`ownerId exceeds ${MAX_OWNER} characters`);
  return ownerId;
}
