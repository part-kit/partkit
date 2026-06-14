import { ApiKeyError } from "./errors";
import { decoyCompare, digestsEqual, generateKey, hashSecret, newSalt, parseKey } from "./keys";
import {
  INSERT_SQL,
  REVOKE_SQL,
  rowToContext,
  rowToInfo,
  rowToVerifyRow,
  ROTATE_OLD_SQL,
  SELECT_BY_OWNER_SQL,
  SELECT_BY_PREFIX_SQL,
  TOUCH_SQL,
  type VerifyRow,
} from "./sql";
import type {
  ApiKeyContext,
  ApiKeyInfo,
  ApiKeyStore,
  IssueKeyInput,
  IssuedKey,
  RotateOptions,
  SqlExecutor,
  VerifyOptions,
} from "./types";
import {
  validateGraceSeconds,
  validateId,
  validateIssue,
  validateOwnerId,
  validateScopes,
} from "./validate";

/** Only write last_used_at once per minute per key — keeps verify read-mostly. */
const LAST_USED_THROTTLE_MS = 60_000;

function storageError(action: string, cause: unknown): ApiKeyError {
  // Generic message; the raw driver error (possible credentials) stays on cause.
  return new ApiKeyError("storage", `failed to ${action}`, { cause });
}

export function createStore(db: SqlExecutor): ApiKeyStore {
  async function issueKey(input: IssueKeyInput): Promise<IssuedKey> {
    const v = validateIssue(input); // throws invalid_input before any SQL
    const km = generateKey();
    const salt = newSalt();
    const hash = hashSecret(km.secret, salt);
    let result: { rows: Record<string, unknown>[] };
    try {
      result = await db.query(INSERT_SQL, [
        km.prefix,
        hash,
        salt,
        v.ownerId,
        v.name,
        v.scopes,
        v.expiresAt,
      ]);
    } catch (e) {
      throw storageError("issue api key", e);
    }
    if (result.rows[0] === undefined) {
      throw new ApiKeyError(
        "storage",
        "issue returned no row — is the auth_apikey_keys migration applied?",
      );
    }
    return { id: km.prefix, plaintext: km.token, prefix: km.prefix };
  }

  async function loadByPrefix(prefix: string, action: string): Promise<VerifyRow | null> {
    let result: { rows: Record<string, unknown>[] };
    try {
      result = await db.query(SELECT_BY_PREFIX_SQL, [prefix]);
    } catch (e) {
      throw storageError(action, e);
    }
    const row = result.rows[0];
    return row === undefined ? null : rowToVerifyRow(row);
  }

  async function verifyKey(presented: string, opts?: VerifyOptions): Promise<ApiKeyContext> {
    const requiredScopes = validateScopes(opts?.requireScopes);

    const parsed = parseKey(presented);
    if (parsed === null) {
      throw new ApiKeyError("malformed", "the presented value is not a well-formed API key");
    }

    const row = await loadByPrefix(parsed.prefix, "verify api key");
    if (row === null) {
      // Unknown prefix: do the same hash+compare work as a real attempt so the
      // response time does not reveal whether the prefix exists (invariant 3).
      decoyCompare(parsed.secret);
      throw new ApiKeyError("invalid", "invalid API key");
    }

    const computed = hashSecret(parsed.secret, row.salt);
    if (!digestsEqual(computed, row.keyHash)) {
      // Wrong secret — indistinguishable from an unknown prefix to the caller.
      throw new ApiKeyError("invalid", "invalid API key");
    }

    // The caller has proven possession of the secret. Only now is it safe to
    // disclose lifecycle state — a random guesser never reaches these branches.
    const now = Date.now();
    if (row.revokedAt !== null) {
      throw new ApiKeyError("revoked", "this API key has been revoked");
    }
    if (row.graceUntil !== null && now >= row.graceUntil.getTime()) {
      throw new ApiKeyError("expired", "this API key was rotated out and its grace window has ended");
    }
    if (row.expiresAt !== null && now >= row.expiresAt.getTime()) {
      throw new ApiKeyError("expired", "this API key has expired");
    }

    for (const scope of requiredScopes) {
      if (!row.scopes.includes(scope)) {
        throw new ApiKeyError("forbidden", "this API key lacks a required scope");
      }
    }

    await touch(row, now);
    return rowToContext(row); // lastUsedAt is the PRIOR value (before this verify)
  }

  /** Best-effort, throttled last-seen write — never fails an otherwise-valid key. */
  async function touch(row: VerifyRow, now: number): Promise<void> {
    const last = row.lastUsedAt === null ? 0 : row.lastUsedAt.getTime();
    if (now - last < LAST_USED_THROTTLE_MS) return; // recent enough — skip the write
    try {
      await db.query(TOUCH_SQL, [row.prefix]);
    } catch {
      // A failed last-seen update must not deny access to a valid key.
    }
  }

  async function rotateKey(id: string, opts?: RotateOptions): Promise<IssuedKey> {
    const vid = validateId(id);
    const grace = validateGraceSeconds(opts?.graceSeconds);

    const old = await loadByPrefix(vid, "rotate api key");
    if (old === null) {
      throw new ApiKeyError("not_found", "no API key with that id");
    }
    // Rotate only a live key. Refusing an already-rotated or revoked key keeps
    // the grace window bounded in aggregate (it cannot be reset forward by
    // re-rotating the same id) and prevents minting orphan keys from a dead one.
    if (old.rotatedAt !== null) {
      throw new ApiKeyError("invalid_input", "this key has already been rotated; rotate its successor");
    }
    if (old.revokedAt !== null) {
      throw new ApiKeyError("invalid_input", "this key has been revoked and cannot be rotated");
    }

    // Mint the replacement FIRST so a failure here leaves the old key fully
    // valid (no outage). Carries over owner, name, scopes, and expiry.
    const km = generateKey();
    const salt = newSalt();
    const hash = hashSecret(km.secret, salt);
    try {
      await db.query(INSERT_SQL, [
        km.prefix,
        hash,
        salt,
        old.ownerId,
        old.name,
        old.scopes,
        old.expiresAt,
      ]);
    } catch (e) {
      throw storageError("rotate api key", e);
    }

    // Then start the old key's grace countdown. For atomicity across both
    // statements, hand a transaction-bound executor (seams.md §5).
    try {
      await db.query(ROTATE_OLD_SQL, [vid, grace]);
    } catch (e) {
      throw storageError("rotate api key", e);
    }

    return { id: km.prefix, plaintext: km.token, prefix: km.prefix };
  }

  async function revokeKey(id: string): Promise<void> {
    const vid = validateId(id);
    let result: { rows: Record<string, unknown>[] };
    try {
      result = await db.query(REVOKE_SQL, [vid]);
    } catch (e) {
      throw storageError("revoke api key", e);
    }
    if (result.rows[0] === undefined) {
      throw new ApiKeyError("not_found", "no API key with that id");
    }
  }

  async function listKeys(ownerId: string): Promise<ApiKeyInfo[]> {
    const v = validateOwnerId(ownerId);
    let result: { rows: Record<string, unknown>[] };
    try {
      result = await db.query(SELECT_BY_OWNER_SQL, [v]);
    } catch (e) {
      throw storageError("list api keys", e);
    }
    return result.rows.map(rowToInfo);
  }

  function requireApiKey(scopes?: string[]): (request: Request) => Promise<ApiKeyContext> {
    return async (request: Request): Promise<ApiKeyContext> => {
      const header =
        typeof request?.headers?.get === "function"
          ? request.headers.get("authorization")
          : null;
      if (header === null) {
        throw new ApiKeyError("malformed", "missing Authorization header");
      }
      // Bound the raw header BEFORE any trim/regex/slice work — an unbounded
      // header is a pre-auth DoS amplifier even though parseKey caps the secret.
      // A real "Bearer <key>" is well under 8 KB.
      if (header.length > 8192) {
        throw new ApiKeyError("malformed", "Authorization header is too large");
      }
      const trimmed = header.trim();
      if (trimmed === "") {
        throw new ApiKeyError("malformed", "missing Authorization header");
      }
      const match = /^Bearer\s+(\S.*)$/i.exec(trimmed);
      if (match === null) {
        throw new ApiKeyError("malformed", "Authorization header must be 'Bearer <key>'");
      }
      const scopeOpt = scopes === undefined ? {} : { requireScopes: scopes };
      return verifyKey(match[1] as string, scopeOpt);
    };
  }

  return { issueKey, verifyKey, rotateKey, revokeKey, listKeys, requireApiKey };
}
