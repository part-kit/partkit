# RFC 0002 — `auth.apikey` capability

**Status:** accepted 2026-06-12 (namespace addition authorized by Rado; chief-architect session)
**Adds capability:** `auth.apikey@1`
**Unblocks:** the AI-app / API-product skeleton (App Pack `ai-api`); composes with `ratelimit.api`, `billing.usage`, `audit.log`
**Author:** chief-architect session, 2026-06-12

## 1. Problem

`auth.session` answers "is this a logged-in human in a browser?" — cookies,
CSRF, redirects. It is the wrong tool for the request that defines API
products and AI apps: a **programmatic caller presenting a long-lived key**.
Those callers have no cookie jar, no login redirect, and no session; they send
`Authorization: Bearer pk_live_…` from a script, a backend, or another
service. Hand-rolling this is where vibecoded API products leak: keys stored in
plaintext, no scoping, no rotation, no revocation, comparison that leaks timing.

`auth.apikey` is the verified primitive for issuing, scoping, verifying,
rotating, and revoking API keys — the API-facing sibling of `auth.session`.

## 2. Interface (`auth.apikey@1`)

```ts
// Issuance returns the plaintext ONCE; only a hash is ever stored.
issueKey(input: {
  ownerId: string;              // user or org id (the app's principal)
  name?: string;                // human label, shown in dashboards
  scopes?: string[];            // capability strings the key may exercise
  expiresAt?: Date | null;      // null = non-expiring
}): Promise<{ id: string; plaintext: string; prefix: string }>;

// Verification is the hot path: constant-time, no I/O beyond one keyed lookup.
verifyKey(presented: string, opts?: {
  requireScopes?: string[];     // all must be present, else ApiKeyError("forbidden")
}): Promise<ApiKeyContext>;      // { id, ownerId, scopes, lastUsedAt } | throws

rotateKey(id: string): Promise<{ plaintext: string; prefix: string }>;  // old key still valid until graceUntil
revokeKey(id: string): Promise<void>;                                    // immediate
listKeys(ownerId: string): Promise<ApiKeyInfo[]>;                        // never returns plaintext or hash

class ApiKeyError extends Error { code: "invalid" | "expired" | "revoked" | "forbidden" | "malformed" }
```

Owns tables `auth_apikey_*` (forward-only migrations, `partkit migrate`).
HTTP middleware seam: `requireApiKey(scopes?)(request) => ApiKeyContext`.

## 3. Invariants (each maps to ≥1 conformance test)

1. Importing performs no I/O and never throws; verification validates input with typed errors.
2. **The plaintext is returned exactly once, at issue/rotate, and never stored** — only a salted hash (argon2id or scrypt) and a non-secret display `prefix` persist; `listKeys` never exposes secret material.
3. Verification is **constant-time** against the stored hash — a wrong key and a wrong-but-same-length key take indistinguishable time (no early-return on first mismatching byte).
4. A revoked key fails `verifyKey` immediately; an expired key fails as `expired`; neither is distinguishable from `invalid` to the caller beyond the typed code (no oracle that confirms a key *existed*).
5. `requireScopes` is all-of: a key missing any required scope fails `forbidden`, never silently downgrades.
6. Rotation keeps the old key valid until a bounded grace window (default 0 = immediate; configurable) so callers can swap without an outage; the window is recorded, not implicit.
7. Secret values (plaintext keys, hashes) never appear in error messages, logs, or `ApiKeyError`.

## 4. Implementation notes for the part author

- **Zero npm dependencies preferred** — Node's `crypto` provides `scrypt`,
  `randomBytes`, and `timingSafeEqual`; reach for `argon2`/`@node-rs/argon2`
  via `npm_dependencies` (RFC 0001) only if the SPEC.md justifies it over
  scrypt. The key format is `<prefix>_<base62(randomBytes(24))>`; store
  `hash(plaintext)` keyed by the prefix so verification is one indexed lookup
  then one constant-time compare.
- DB-backed → follow the `audit.log` conformance pattern: persistence/rotation/
  revocation invariants against real Postgres gated on
  `PARTKIT_TEST_DATABASE_URL`; the constant-time and validation invariants run
  DB-free so the suite still attests without a database.
- `ownerId` is opaque — the part does not own users; it references whatever
  principal the app's `auth.session` / `auth.tenancy` provides. That keeps
  `auth.apikey` usable in an API product that has no human login at all.
- Scopes are free strings the app defines; the part enforces presence, not
  meaning. Document the recommended convention (`capability.action`) in seams.md.

## 5. Roadmap (not v1)

- Per-key rate-limit budgets handed to `ratelimit.api` as the identity key (seam, documented in both seams.md files).
- Per-key usage metering feeding `billing.usage` (the metering key is the API key id).
- HMAC request signing (beyond bearer presentation) as an additive minor.
