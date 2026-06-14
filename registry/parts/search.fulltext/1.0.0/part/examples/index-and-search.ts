/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * Keep a document in the index on write, and serve a search box.
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { search, type SearchResult, type SqlExecutor } from "@parts/search.fulltext";
 */
import { search, type SearchResult, type SqlExecutor } from "../src/index";

/** Call from your "listing created/updated" handler — upsert keeps it searchable. */
export async function indexListing(
  db: SqlExecutor,
  listing: { id: string; name: string; description: string; priceCents: number },
): Promise<void> {
  await search(db).index({
    ref: listing.id,
    type: "listing",
    title: listing.name,
    body: listing.description,
    metadata: { priceCents: listing.priceCents },
  });
}

/** Call from your "listing deleted" handler. */
export function deindexListing(db: SqlExecutor, listingId: string): Promise<void> {
  return search(db).remove(listingId);
}

/**
 * Serve a search box. `q` is the raw user input — pass it straight through; it
 * never throws on odd syntax. Remember: result.snippet is NOT HTML-safe —
 * escape it before rendering as HTML (seams.md §5).
 */
export function searchListings(
  db: SqlExecutor,
  q: string,
  page = 0,
): Promise<SearchResult[]> {
  return search(db).query({ q, type: "listing", limit: 20, offset: page * 20 });
}
