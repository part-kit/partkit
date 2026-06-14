/**
 * The driver-free database seam — the same minimal `node-postgres` Client/Pool
 * shape `partkit migrate` uses. The app wires its own `pg` Pool to this; the
 * part imports no driver (contract invariant 8). Wiring example: seams.md §2.
 */
export interface SqlExecutor {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** What the app passes to mint a key. Only `ownerId` is required. */
export interface IssueKeyInput {
  /**
   * The principal the key acts as — a user or org id from your auth.session /
   * auth.tenancy. Opaque to the part: it stores and returns the string, nothing
   * more, so this works even in an API product with no human login.
   */
  ownerId: string;
  /** Human label shown in dashboards (e.g. "CI deploy", "Zapier"). Optional. */
  name?: string;
  /**
   * Capability strings this key may exercise (your convention; `capability.action`
   * recommended). Enforced for presence by verifyKey/requireScopes, not meaning.
   */
  scopes?: string[];
  /** When the key stops verifying. `null`/omitted = non-expiring. */
  expiresAt?: Date | null;
}

/**
 * The result of issueKey/rotateKey. `plaintext` is the ONLY time the full key
 * is ever available — it is not stored and cannot be recovered. Show it once,
 * then forget it (contract invariant 2).
 */
export interface IssuedKey {
  /** Stable management handle — pass to rotateKey/revokeKey. Equals the prefix. */
  id: string;
  /** The full secret key. Returned once; never persisted. */
  plaintext: string;
  /** The non-secret leading segment, safe to display (e.g. "ak7Gh2Kp9qLw"). */
  prefix: string;
}

export interface VerifyOptions {
  /** All of these scopes must be present, else ApiKeyError("forbidden"). */
  requireScopes?: string[];
}

export interface RotateOptions {
  /**
   * Seconds the OLD key stays valid after rotation so callers can swap without
   * an outage. Default 0 = the old key is invalid immediately. The window is
   * recorded on the old key, never implicit (contract invariant 6).
   */
  graceSeconds?: number;
}

/** What a successful verifyKey resolves to — never includes secret material. */
export interface ApiKeyContext {
  /** The key's management id (= prefix). */
  id: string;
  /** The principal the key acts as. */
  ownerId: string;
  /** The scopes granted to this key. */
  scopes: string[];
  /** When the key was last seen before this verification (null = first use). */
  lastUsedAt: Date | null;
}

/** A key as listKeys returns it — management metadata only, never a secret. */
export interface ApiKeyInfo {
  id: string;
  /** The non-secret display prefix, so a human can recognize the key. */
  prefix: string;
  name: string | null;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  /** null = non-expiring. */
  expiresAt: Date | null;
  /** Set once the key has been revoked. */
  revokedAt: Date | null;
}

export interface ApiKeyStore {
  issueKey(input: IssueKeyInput): Promise<IssuedKey>;
  verifyKey(presented: string, opts?: VerifyOptions): Promise<ApiKeyContext>;
  rotateKey(id: string, opts?: RotateOptions): Promise<IssuedKey>;
  revokeKey(id: string): Promise<void>;
  listKeys(ownerId: string): Promise<ApiKeyInfo[]>;
  /**
   * HTTP middleware seam: returns a guard that reads `Authorization: Bearer
   * <key>` off a Request and resolves the verified context (or throws a typed
   * ApiKeyError). Optionally requires scopes (all-of).
   */
  requireApiKey(scopes?: string[]): (request: Request) => Promise<ApiKeyContext>;
}
