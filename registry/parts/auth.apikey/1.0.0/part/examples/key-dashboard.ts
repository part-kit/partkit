/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * The developer-dashboard side: issue a key (show the plaintext ONCE), list a
 * principal's keys, rotate with a grace window, and revoke.
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { apiKeys, type SqlExecutor } from "@parts/auth.apikey";
 *
 * AUTHORIZATION IS YOURS: rotateKey/revokeKey act by key id and do not check
 * ownership. Before calling them, confirm the id belongs to the signed-in
 * principal — e.g. that it appears in listKeys(currentOwnerId). seams.md §5.
 */
import { apiKeys, type ApiKeyInfo, type SqlExecutor } from "../src/index";

/**
 * Mint a key for the signed-in principal. Return the plaintext to render it
 * exactly once ("copy it now — you won't see it again"); never store it yourself.
 */
export async function createKey(
  db: SqlExecutor,
  ownerId: string,
  name: string,
  scopes: string[],
): Promise<{ plaintext: string; prefix: string }> {
  const { plaintext, prefix } = await apiKeys(db).issueKey({ ownerId, name, scopes });
  return { plaintext, prefix };
}

/** The key table for a settings page — metadata only, never a secret. */
export function listOwnerKeys(db: SqlExecutor, ownerId: string): Promise<ApiKeyInfo[]> {
  return apiKeys(db).listKeys(ownerId);
}

/**
 * Rotate a key the principal owns, keeping the old one alive for `graceSeconds`
 * so a deployed caller can swap without downtime. Ownership-checks first.
 */
export async function rotateOwnedKey(
  db: SqlExecutor,
  ownerId: string,
  id: string,
  graceSeconds: number,
): Promise<{ plaintext: string; prefix: string }> {
  await assertOwns(db, ownerId, id);
  const { plaintext, prefix } = await apiKeys(db).rotateKey(id, { graceSeconds });
  return { plaintext, prefix };
}

/** Revoke a key the principal owns — immediate. Ownership-checks first. */
export async function revokeOwnedKey(db: SqlExecutor, ownerId: string, id: string): Promise<void> {
  await assertOwns(db, ownerId, id);
  await apiKeys(db).revokeKey(id);
}

/** The ownership gate the part deliberately leaves to the app. */
async function assertOwns(db: SqlExecutor, ownerId: string, id: string): Promise<void> {
  const owned = await apiKeys(db).listKeys(ownerId);
  if (!owned.some((k) => k.id === id)) {
    throw new Error("forbidden: that key does not belong to this owner");
  }
}
