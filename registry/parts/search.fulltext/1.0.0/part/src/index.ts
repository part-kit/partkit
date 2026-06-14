/**
 * search.fulltext — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 *
 * Postgres-native full-text search: index documents, then search them with raw
 * user query strings safely, ranked (title over body) with highlighted snippets
 * — on plain Postgres, no separate search vendor. Bind it to a database
 * connection (the SqlExecutor seam); constructing it performs no I/O.
 */
import { createSearch } from "./internal/search";
import type { SearchIndex, SqlExecutor } from "./internal/types";

export { SearchError } from "./internal/errors";
export type { SearchErrorCode } from "./internal/errors";
export type {
  IndexDocInput,
  SearchIndex,
  SearchQuery,
  SearchResult,
  SqlExecutor,
} from "./internal/types";

/**
 * Bind the search index to a database connection (the SqlExecutor seam).
 * Constructing it performs no I/O and never throws (contract invariant 1).
 *
 *   const idx = search(db);
 *   await idx.index({ ref: listing.id, type: "listing", title: listing.name, body: listing.description });
 *   const hits = await idx.query({ q: 'leather "office chair" -broken', type: "listing", limit: 20 });
 *
 * NOTE: result.snippet is highlighted (<mark>…</mark>) but NOT HTML-escaped —
 * escape it before rendering as HTML (seams.md §5).
 */
export function search(db: SqlExecutor): SearchIndex {
  return createSearch(db);
}
