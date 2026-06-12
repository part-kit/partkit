/**
 * EXAMPLE SEAM — this file is OUTSIDE the boundary: copy it into your app
 * (e.g. src/db/admin-executor.ts) and edit freely. It is not attested.
 *
 * After copying, change the import to your alias (seams.md §1):
 *   import type { SqlExecutor } from "@parts/admin.crud";
 *
 * Adapts a node-postgres Pool or Client to the SqlExecutor admin.crud uses for
 * READS. admin.crud never writes through it — writes go through part mutators.
 * Defined structurally so this example compiles without @types/pg.
 */
import type { SqlExecutor } from "../src/index";

/** The slice of node-postgres `Pool`/`Client` the seam needs. */
interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function pgExecutor(pool: PgQueryable): SqlExecutor {
  return {
    query: (sql, params) => pool.query(sql, params === undefined ? undefined : [...params]),
  };
}
