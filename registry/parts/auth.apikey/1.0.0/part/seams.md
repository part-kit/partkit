# Seams — auth.apikey

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested interior;
edits void the attestation and fail CI).

## 1. No env, no adapter — a connection seam + one migration

This part reads **no env vars** and ships **no registry adapters**. It owns one
Postgres table, `auth_apikey_keys`, and reaches it through a connection you hand
in. Import through your alias:

```jsonc
// tsconfig.json → compilerOptions (recommended alias)
"paths": { "@parts/*": ["./parts/*/src"] }
```

```ts
import { apiKeys, ApiKeyError } from "@parts/auth.apikey";
```

Never deep-import `src/internal/**` (lint-enforced).

## 2. The connection seam (`SqlExecutor`)

The part is **driver-free**: it never imports `pg`. You give it the minimal
executor it needs — the same shape `partkit migrate` uses:

```ts
interface SqlExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
```

Wrap your existing `pg` Pool once (copy `examples/pg-executor.ts`):

```ts
const db: SqlExecutor = {
  query: (sql, params) => pool.query(sql, params ? [...params] : undefined),
};
const keys = apiKeys(db);
```

## 3. Run the migration before first use

`partkit add auth.apikey` vendors
`parts/auth.apikey/migrations/001-create-apikey-tables.sql` but does not run it:

```sh
partkit migrate            # reads DATABASE_URL; records the _part_migrations ledger
```

This creates `auth_apikey_keys`. The table is **interior** — never `SELECT`/
`INSERT`/`UPDATE` it directly; read and write only through the store. Its shape
can change across versions; the interface is the contract.

## 4. Issue, verify, scope

```ts
const keys = apiKeys(db);

// Issue — the plaintext is shown EXACTLY ONCE. Render it, then forget it; it is
// not stored and cannot be recovered.
const { id, plaintext, prefix } = await keys.issueKey({
  ownerId: user.id,                 // your principal (user or org id) — opaque to the part
  name: "CI deploy",                // human label for the dashboard (optional)
  scopes: ["models.read", "models.write"], // your convention; `capability.action` recommended
  expiresAt: null,                  // or a Date; null = non-expiring
});
// Show `plaintext` to the user now. Store only `id`/`prefix` to reference it later.

// Verify — the hot path on every API request. One indexed lookup + a
// constant-time compare; `requireScopes` is all-of.
const ctx = await keys.verifyKey(presented, { requireScopes: ["models.read"] });
// ctx = { id, ownerId, scopes, lastUsedAt }  — never any secret material

// Or guard a route directly off the `Authorization: Bearer <key>` header:
const guard = keys.requireApiKey(["models.write"]);
const ctx2 = await guard(request);  // request: the Web Fetch Request
```

`scopes` are free strings **you** define; the part enforces their *presence*
(all required scopes must be on the key), never their meaning. `lastUsedAt` is
the time the key was last seen **before** this verification, written back at most
once a minute (the hot path stays read-mostly).

## 5. Rotate, revoke — and the authorization YOU own

```ts
// Rotate: mint a replacement, keep the old key valid for a grace window so a
// deployed caller can swap without an outage. Default 0 = old key dies at once.
const next = await keys.rotateKey(id, { graceSeconds: 3600 }); // 0..2_592_000 (30d)

// Revoke: immediate and idempotent.
await keys.revokeKey(id);

// List a principal's keys for a settings page — metadata only, never a secret.
const mine = await keys.listKeys(user.id);
```

- **`rotateKey`/`revokeKey` act by key id and do NOT check ownership.** That
  authorization is the app's seam: before calling them, confirm the id belongs
  to the signed-in principal (e.g. it appears in `listKeys(currentOwnerId)`).
  `examples/key-dashboard.ts` shows the gate.
- **`rotateKey` issues two statements** (insert the new key, then start the old
  key's grace). For atomicity, hand a **transaction-bound executor** (one that
  runs inside your `BEGIN`/`COMMIT`). Without one, a failure between the two
  leaves both keys valid — safe (no outage), but retry or revoke the new key.
- A rotated key past its grace window verifies as `expired`, exactly like a
  natural expiry.
- **Rotate the current key, not one you have already rotated.** Re-rotating an
  already-rotated or revoked key is refused (`invalid_input`) — this keeps the
  grace window bounded (it can't be reset forward) and avoids minting orphan
  keys. To re-key again, rotate the *successor* returned by the last rotation.

## 6. Error handling

Every failure is an `ApiKeyError` with `.code`:

| code | meaning | typical HTTP |
|---|---|---|
| `malformed` | the presented value isn't a well-formed key, or no `Bearer` header | 401 |
| `invalid` | unknown key or wrong secret — **deliberately indistinguishable** | 401 |
| `expired` | the key (or its rotation grace) elapsed — only after the secret matches | 401 |
| `revoked` | the key was revoked — only after the secret matches | 401 |
| `forbidden` | valid key, but missing a required scope | 403 |
| `invalid_input` | bad arguments to `issueKey`/`rotateKey` (your bug) | 400/500 |
| `not_found` | `rotateKey`/`revokeKey` on an id that doesn't exist | 404 |
| `storage` | the executor (database) failed. Raw driver error is on `.cause` (may contain credentials — don't log blindly); `.message` is generic and safe. | 500 |

A random guesser only ever sees `malformed` or `invalid` — `expired`/`revoked`/
`forbidden` require presenting the correct secret, so they never confirm a key
exists to someone who doesn't already hold it. When returning errors to API
callers, surface only `.code`, never `.message`. `examples/protect-route.ts`
does this.

## 7. What you must NOT do

- Edit or import anything under `src/internal/**`.
- `SELECT`/`INSERT`/`UPDATE`/`DELETE` against `auth_apikey_keys` directly — use
  the store. Reading it yourself to "check a key" defeats the constant-time path
  and the boundary.
- Store the `plaintext` anywhere. If a user loses a key, issue a new one.
- Log an `ApiKeyError.cause` without scrubbing it.
- Call `rotateKey`/`revokeKey` before confirming the caller owns that key.
