import type { SearchResult } from "./types";

/**
 * Every statement is a CONSTANT string with positional placeholders — even the
 * raw user query is a bound parameter ($1) parsed server-side by
 * websearch_to_tsquery, so there is no injection surface (contract invariant 6).
 * Each references only the part-owned `search_documents` table.
 */

/** Upsert by ref. search_vector is GENERATED — never set it; it regenerates.
 *  Keep created_at OUT of the SET so re-indexing preserves it. */
export const UPSERT_SQL = `INSERT INTO search_documents (ref, type, title, body, metadata)
VALUES ($1, $2, $3, $4, $5::jsonb)
ON CONFLICT (ref) DO UPDATE SET
  type       = EXCLUDED.type,
  title      = EXCLUDED.title,
  body       = EXCLUDED.body,
  metadata   = EXCLUDED.metadata,
  updated_at = now()`;

export const DELETE_SQL = `DELETE FROM search_documents WHERE ref = $1`;

/**
 * Ranked search. The inner subquery filters + ranks + paginates first, so the
 * expensive ts_headline runs only on the returned page rows. websearch_to_tsquery
 * never raises on raw input. Stable secondary sort (ref) → deterministic order.
 * $1 = raw query, $2 = type-or-NULL, $3 = limit, $4 = offset.
 *
 * The ts_headline INPUT is capped with left(..., HEADLINE_BUDGET) because
 * ts_headline is O(document size) and body may be up to MAX_BODY (~1 MB). Without
 * this, a page of large (high-ranking) bodies — or a phrase query — turns one
 * request into seconds of Postgres CPU (resource-exhaustion DoS). MaxFragments=1
 * /MaxWords=20 only ever needs a small window around the first match, so an 8 KB
 * cap yields an identical snippet while bounding cost to O(limit × const).
 */
export const SEARCH_SQL = `SELECT
  h.ref, h.type, h.title, h.rank,
  ts_headline('english',
    left(coalesce(h.title || ' — ' || h.body, h.body), 8192),
    websearch_to_tsquery('english', $1),
    'StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MinWords=5, MaxWords=20, ShortWord=3, FragmentDelimiter=" … "'
  ) AS snippet,
  h.metadata
FROM (
  SELECT ref, type, title, body, metadata,
    ts_rank(search_vector, websearch_to_tsquery('english', $1)) AS rank
  FROM search_documents
  WHERE search_vector @@ websearch_to_tsquery('english', $1)
    AND ($2::text IS NULL OR type = $2)
  ORDER BY rank DESC, ref
  LIMIT $3 OFFSET $4
) h
ORDER BY h.rank DESC, h.ref`;

function asNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function rowToResult(row: Record<string, unknown>): SearchResult {
  const metadata = row["metadata"];
  return {
    ref: String(row["ref"]),
    type: row["type"] === null || row["type"] === undefined ? null : String(row["type"]),
    title: row["title"] === null || row["title"] === undefined ? null : String(row["title"]),
    rank: asNumber(row["rank"]),
    snippet: row["snippet"] === null || row["snippet"] === undefined ? "" : String(row["snippet"]),
    metadata:
      metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {},
  };
}
