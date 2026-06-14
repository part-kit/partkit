/**
 * Example: adapt a node-postgres Pool to the SqlExecutor seam. The part imports
 * no database driver — you bring one. Copy into your app:
 *
 *   import { Pool } from "pg";
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   export const db = pgExecutor(pool);
 *
 * (Any client exposing `query(text, params) → { rows }` works — pg, a pooled
 * proxy, a serverless driver, etc.) Outside the part boundary — edit freely.
 */
import type { SqlExecutor } from "../src/index";

interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function pgExecutor(pool: PgPoolLike): SqlExecutor {
  return {
    query: (sql, params) => pool.query(sql, params === undefined ? undefined : [...params]),
  };
}
