/**
 * EXAMPLE SEAM — this file is OUTSIDE the boundary: copy it into your app
 * (e.g. src/db/jobs-executor.ts) and edit freely. It is not attested.
 *
 * After copying, change the import to your alias (seams.md §1):
 *   import type { SqlExecutor } from "@parts/jobs.queue";
 *
 * Adapts a node-postgres Pool or Client to the SqlExecutor the enqueue/read seam
 * expects. Defined structurally so this example compiles without @types/pg —
 * your real `pg` Pool already satisfies `PgQueryable`.
 */
import type { SqlExecutor } from "../src/index";

/** The slice of node-postgres `Pool`/`Client` the seam needs. */
interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Wrap your pool once and pass the result to `jobs(db)`. Hand in a pooled client
 * mid-transaction to enqueue a job in the same transaction as the business write
 * that triggers it.
 */
export function pgExecutor(pool: PgQueryable): SqlExecutor {
  return {
    query: (sql, params) => pool.query(sql, params === undefined ? undefined : [...params]),
  };
}
