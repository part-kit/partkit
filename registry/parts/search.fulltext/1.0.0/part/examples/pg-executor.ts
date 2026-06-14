/**
 * EXAMPLE SEAM — this file is OUTSIDE the boundary: copy it into your app
 * (e.g. src/db/search-executor.ts) and edit freely. It is not attested.
 *
 * After copying, change the import to your alias (seams.md §1):
 *   import type { SqlExecutor } from "@parts/search.fulltext";
 *
 * Adapts a node-postgres Pool or Client to the SqlExecutor the part expects.
 * Defined structurally so this example compiles without @types/pg.
 */
import type { SqlExecutor } from "../src/index";

interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function pgExecutor(pool: PgQueryable): SqlExecutor {
  return {
    query: (sql, params) => pool.query(sql, params === undefined ? undefined : [...params]),
  };
}
