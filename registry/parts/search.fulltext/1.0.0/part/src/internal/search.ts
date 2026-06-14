import { SearchError } from "./errors";
import { DELETE_SQL, rowToResult, SEARCH_SQL, UPSERT_SQL } from "./sql";
import type { IndexDocInput, SearchIndex, SearchQuery, SearchResult, SqlExecutor } from "./types";
import { validateIndexDoc, validateQuery, validateRef } from "./validate";

export function createSearch(db: SqlExecutor): SearchIndex {
  async function run(
    sql: string,
    params: readonly unknown[],
    action: string,
  ): Promise<{ rows: Record<string, unknown>[] }> {
    try {
      return await db.query(sql, params);
    } catch (e) {
      // Generic message; the raw driver error (possible credentials) stays on cause.
      throw new SearchError("storage", `failed to ${action}`, { cause: e });
    }
  }

  async function index(doc: IndexDocInput): Promise<void> {
    const v = validateIndexDoc(doc); // throws invalid_input before any SQL
    await run(UPSERT_SQL, [v.ref, v.type, v.title, v.body, v.metadataJson], "index document");
  }

  async function remove(ref: string): Promise<void> {
    const r = validateRef(ref);
    await run(DELETE_SQL, [r], "remove document"); // idempotent: 0 rows when absent
  }

  async function query(input: SearchQuery): Promise<SearchResult[]> {
    const v = validateQuery(input);
    // An empty / whitespace query yields the empty tsquery (0 matches); short-
    // circuit to skip a pointless round-trip. websearch_to_tsquery never throws
    // on the non-empty raw input we do send (contract invariant 3).
    if (v.q.trim() === "") return [];
    const res = await run(SEARCH_SQL, [v.q, v.type, v.limit, v.offset], "search documents");
    return res.rows.map(rowToResult);
  }

  return { index, remove, query };
}
