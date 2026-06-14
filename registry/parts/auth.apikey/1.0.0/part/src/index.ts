/**
 * auth.apikey — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 *
 * Issue, verify, scope, rotate, and revoke long-lived API keys — the
 * programmatic sibling of auth.session. Bind it to a database connection (the
 * SqlExecutor seam) and use the returned store; constructing it performs no I/O.
 */
import { createStore } from "./internal/store";
import type { ApiKeyStore, SqlExecutor } from "./internal/types";

export { ApiKeyError } from "./internal/errors";
export type { ApiKeyErrorCode } from "./internal/errors";
export type {
  ApiKeyContext,
  ApiKeyInfo,
  ApiKeyStore,
  IssueKeyInput,
  IssuedKey,
  RotateOptions,
  SqlExecutor,
  VerifyOptions,
} from "./internal/types";

/**
 * Bind the API-key store to a database connection (the SqlExecutor seam).
 * Constructing it performs no I/O and never throws (contract invariant 1) —
 * the database is touched only when a method runs, so it is serverless-safe.
 * Pass a per-request executor from your pool; for rotation atomicity hand a
 * transaction-bound executor (seams.md §5).
 *
 *   const keys = apiKeys(db);
 *   const { plaintext } = await keys.issueKey({ ownerId, scopes: ["models.read"] });
 *   const ctx = await keys.verifyKey(presented, { requireScopes: ["models.read"] });
 */
export function apiKeys(db: SqlExecutor): ApiKeyStore {
  return createStore(db);
}
