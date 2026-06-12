import { AdminError } from "./errors";
import type { ColumnDescriptor, ListOptions, ReadDescriptor, ResourceDeclaration } from "./types";

/**
 * Strict identifier: lowercase snake_case, the PartKit table/column convention.
 * Every identifier admin.crud puts into SQL is validated against this AND
 * double-quoted (contract invariant 5) — a malformed reads declaration can never
 * inject. Values are always parameterized, never interpolated.
 */
const IDENT = /^[a-z_][a-z0-9_]*$/;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function invalidContract(detail: string): AdminError {
  return new AdminError("invalid_contract", detail);
}
function invalidInput(detail: string): AdminError {
  return new AdminError("invalid_input", detail);
}

/** Validate + double-quote a single identifier. */
export function quoteIdent(name: string): string {
  if (typeof name !== "string" || !IDENT.test(name)) {
    throw invalidContract(`"${String(name)}" is not a valid identifier`);
  }
  return `"${name}"`;
}

/** Validate + quote a possibly schema-qualified table (`schema.table` or `table`). */
export function quoteTable(table: string): string {
  const segments = table.split(".");
  if (segments.length < 1 || segments.length > 2) {
    throw invalidContract(`"${table}" is not a valid table name`);
  }
  return segments.map((s) => quoteIdent(s)).join(".");
}

/** A resolved, validated view of one administered resource. */
export interface ResolvedResource {
  part: string;
  table: string;
  descriptor: ReadDescriptor;
  primaryKey: string[];
  /** Declared columns minus redacted ones — the only legal projection. */
  readable: ColumnDescriptor[];
}

function primaryKeyOf(descriptor: ReadDescriptor): string[] {
  const pk = descriptor.primary_key;
  const keys = Array.isArray(pk) ? pk : [pk];
  if (keys.length === 0) throw invalidContract("primary_key is empty");
  for (const k of keys) quoteIdent(k); // validate now, fail fast
  return keys;
}

/**
 * Find the resource for `table` across all installed parts' reads. A table not
 * declared in any reads map is unknown — there is NO raw-table fallback
 * (contract invariant 3). The first declaring part wins (tables are part-owned,
 * so there is at most one).
 */
export function resolveResource(
  resources: ResourceDeclaration[],
  table: string,
): ResolvedResource {
  for (const r of resources) {
    const descriptor = r.reads[table];
    if (descriptor !== undefined) {
      const readable = descriptor.columns.filter((c) => c.redact !== true);
      return { part: r.part, table, descriptor, primaryKey: primaryKeyOf(descriptor), readable };
    }
  }
  throw new AdminError(
    "unknown_resource",
    `"${table}" is not an administered resource (no installed part declares it in data_ownership.reads)`,
  );
}

/** Normalize + bound list paging. */
export function validateListOptions(opts: ListOptions): { limit: number; offset: number } {
  let limit = DEFAULT_LIMIT;
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_LIMIT) {
      throw invalidInput(`limit must be an integer in 1..${MAX_LIMIT}`);
    }
    limit = opts.limit;
  }
  let offset = 0;
  if (opts.offset !== undefined) {
    if (!Number.isInteger(opts.offset) || opts.offset < 0) {
      throw invalidInput("offset must be a non-negative integer");
    }
    offset = opts.offset;
  }
  return { limit, offset };
}

/**
 * Validate a key against the resource's primary key and return the values in PK
 * order (for a parameterized WHERE). The key must carry exactly the PK columns.
 */
export function orderedKeyValues(
  key: Record<string, unknown>,
  primaryKey: string[],
): (string | number)[] {
  if (typeof key !== "object" || key === null || Array.isArray(key)) {
    throw invalidInput("key must be an object of primary-key columns");
  }
  const provided = Object.keys(key);
  if (provided.length !== primaryKey.length || !primaryKey.every((k) => k in key)) {
    throw invalidInput(`key must provide exactly the primary key: ${primaryKey.join(", ")}`);
  }
  return primaryKey.map((col) => {
    const v = key[col];
    if (typeof v !== "string" && typeof v !== "number") {
      throw invalidInput(`key.${col} must be a string or number`);
    }
    return v;
  });
}

/**
 * Build a safe ORDER BY fragment from the descriptor's `order_by`. Each column
 * must be a declared, non-redacted column (so admin never orders by a column it
 * cannot read); direction is asc/desc only. Returns null when no order_by.
 */
export function buildOrderBy(
  orderBy: string | undefined,
  readable: ColumnDescriptor[],
): string | null {
  if (orderBy === undefined) return null;
  const readableNames = new Set(readable.map((c) => c.name));
  const out: string[] = [];
  for (const raw of orderBy.split(",")) {
    const term = raw.trim();
    if (term === "") continue;
    const m = /^([a-z_][a-z0-9_]*)(?:\s+(asc|desc))?$/i.exec(term);
    if (m === null) throw invalidContract(`order_by "${orderBy}" is malformed`);
    const col = m[1]!.toLowerCase();
    if (!readableNames.has(col)) {
      throw invalidContract(`order_by references undeclared or redacted column "${col}"`);
    }
    const dir = (m[2] ?? "asc").toUpperCase();
    out.push(`${quoteIdent(col)} ${dir}`);
  }
  return out.length > 0 ? out.join(", ") : null;
}
