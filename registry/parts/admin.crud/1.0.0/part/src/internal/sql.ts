import type { ColumnDescriptor } from "./types";
import { quoteIdent, quoteTable } from "./validate";

/**
 * admin.crud builds ONLY read SELECTs, and only from validated + double-quoted
 * identifiers with parameterized values (contract invariant 5). There is no
 * write-SQL builder at all — writes go through part mutators (invariant 4), so a
 * raw admin write path does not exist to be exploited.
 *
 * The projection is exactly the readable (non-redacted) declared columns
 * (invariant 2). `$1`/`$2` are the paged limit/offset.
 */
export function buildListSql(
  table: string,
  readable: ColumnDescriptor[],
  orderBy: string | null,
): string {
  const cols = readable.map((c) => quoteIdent(c.name)).join(", ");
  return (
    `SELECT ${cols} FROM ${quoteTable(table)}` +
    (orderBy !== null ? ` ORDER BY ${orderBy}` : "") +
    ` LIMIT $1 OFFSET $2`
  );
}

/** Read one row by primary key; PK columns are bound as `$1..$n`. */
export function buildGetSql(
  table: string,
  readable: ColumnDescriptor[],
  primaryKey: string[],
): string {
  const cols = readable.map((c) => quoteIdent(c.name)).join(", ");
  const where = primaryKey.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(" AND ");
  return `SELECT ${cols} FROM ${quoteTable(table)} WHERE ${where} LIMIT 1`;
}
