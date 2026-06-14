# auth.apikey — design notes & threat model

`auth.apikey` is the verified primitive for **programmatic** authentication:
issue, scope, verify, rotate, and revoke long-lived API keys. It is the
API-facing sibling of `auth.session` (cookies/redirects for humans in a
browser). A key is a bearer credential a script or backend presents as
`Authorization: Bearer <key>` — no cookie jar, no login flow, no session.

The whole part is **zero-dependency** (node:crypto only) and **driver-free**
(the database is the `SqlExecutor` app seam, like `audit.log`). It owns one
table, `auth_apikey_keys`, and reads no env.

## Key format

```
ak7Gh2Kp9qLw_3nF…(33 base62 chars)
└─── prefix ──┘ └──── secret ────┘
```

- **prefix** = `"ak"` + base62(9 random bytes). Public, unique, indexed. It is
  both the verify-time lookup key and the management `id` returned to the app —
  safe to show in dashboards (`ak7Gh2Kp9qLw…`).
- **secret** = base62(24 random bytes) = **192 bits** of entropy.

Verification splits on the first `_`, looks the row up by `prefix` (one indexed
query), then does a single constant-time compare. Shape (brand, separator,
charset, minimum length) is public, so rejecting a malformed value as
`malformed` rather than `invalid` leaks nothing about whether a key exists.

## Why a fast keyed hash, not a password KDF

We store **HMAC-SHA256(key = per-key salt, message = secret)** — a salted,
one-way, fast digest — and compare it with `crypto.timingSafeEqual`. We do
**not** use a password-hashing KDF (scrypt/argon2/bcrypt).

RFC 0002 §4 originally suggested scrypt by analogy to password storage. That
analogy is wrong for this credential, and the part deviates deliberately (see
the RFC 0002 amendment, 2026-06-14):

- The secret is **192 bits of machine-generated randomness**. Brute force is
  already impossible at any hash speed — there is no dictionary, no reuse, no
  low-entropy human choice for a slow KDF to defend.
- Verification is the **hot path** — every API request. A KDF would add tens of
  milliseconds and consume a libuv threadpool slot per call, capping throughput
  for no security gain. HMAC-SHA256 is microseconds and never blocks.
- The per-key salt (used as the HMAC key) makes the digest salted and unique per
  key, so identical inputs never collide and a stolen database of digests is not
  a rainbow-table target.

If lower-entropy keys were ever introduced (they should not be), a KDF would
become the right call — that is the only scenario in which this decision flips.

The known-answer conformance test pins `hashSecret` to a fixed HMAC-SHA256
vector, so a weaker or reversible substitute cannot silently pass the suite.

## Verify order: prove possession before disclosing state

`verifyKey` discloses lifecycle state **only after the secret matches**:

1. Parse + shape-check → `malformed` (no DB touched).
2. Look up by prefix. **Unknown prefix → run a decoy HMAC, then `invalid`** —
   the CPU work matches a real attempt so timing doesn't reveal whether the
   prefix exists.
3. Constant-time compare. **Mismatch → `invalid`** (indistinguishable from an
   unknown prefix).
4. Only now: `revoked` → `expired` (rotation grace, then natural expiry) →
   scope check (`forbidden`).

So a random guesser only ever sees `malformed`/`invalid`; `revoked`/`expired`/
`forbidden` are reachable only by someone presenting the correct secret — i.e.
the key holder. There is no oracle that confirms a key existed.

## Rotation grace

`rotateKey(id, { graceSeconds })` mints a replacement (carrying over owner,
name, scopes, expiry) **first** — so a failure leaves the old key fully valid,
never an outage — then records `rotated_at` and a bounded `grace_until` on the
old key (default 0 = retire immediately; max 30 days). During the window both
keys verify; after it the old key is `expired`. The window is stored, never
implicit. Re-rotating an already-rotated (or revoked) key is refused
(`invalid_input`) so the grace window is bounded **in aggregate** — it cannot be
reset forward by re-rotating the same id, and no orphan keys are minted from a
dead one; rotate the successor instead. The two statements are atomic only
inside a caller-provided transaction (seams.md §5).

## last_used_at is throttled

`verifyKey` returns `lastUsedAt` (the time before this call) and writes
`now()` back **at most once per minute per key** — the hot path stays a single
read on the common path. The write is best-effort: if it fails, a valid key is
still accepted (availability over a perfect last-seen).

## Ownership is the app's seam

`rotateKey`/`revokeKey` act by id and do not check ownership — the part does not
own users. The app confirms the id belongs to the requesting principal (via
`listKeys(ownerId)`) before calling. Keeping `ownerId` opaque is what lets this
part secure an API product that has **no human login at all**.

## <a id="threat-model"></a>Threat model

| Threat | Mitigation |
|---|---|
| **Database disclosure** (backup/SQLi elsewhere leaks `auth_apikey_keys`) | Only a one-way HMAC digest + salt persist; the 192-bit plaintext is never stored and cannot be recovered or brute-forced. |
| **Key enumeration / existence oracle** | Unknown prefix and wrong secret both return `invalid` after equivalent (decoy) work; `revoked`/`expired` require the correct secret. No timing or status oracle reveals which prefixes exist. |
| **Timing side-channel on compare** | Fixed-width digests compared with `timingSafeEqual`; no early return on first differing byte; length differences never reach a discriminating branch. |
| **Privilege escalation via scopes** | `requireScopes` is strict all-of; a missing scope is `forbidden`, never a silent downgrade. Scope strings are stored canonically (deduped, sorted) and parameterized. |
| **Stale credentials after compromise** | `revokeKey` is immediate; `rotateKey` swaps with a bounded, recorded grace window; `expiresAt` bounds lifetime up front. |
| **SQL injection via key metadata** | Every statement is a constant string with positional parameters; ownerId/name/scopes are data, never code; statements touch only `auth_apikey_keys`. |
| **Secret leakage through errors/logs** | No plaintext/hash/salt appears in any `ApiKeyError` message or returned value; storage errors carry the raw driver error only on `.cause` with a generic `.message`. |
| **Hot-path denial of service** | Verification is one indexed lookup + a microsecond HMAC compare; no KDF, no unbounded work; last-seen writes are throttled. |

### Out of scope (v1, see RFC 0002 §5)

Per-key rate-limit budgets handed to `ratelimit.api`, per-key usage metering
feeding `billing.usage`, and HMAC **request signing** (beyond bearer
presentation) are additive futures wired as seams, not part of `auth.apikey@1`.
A server-side pepper is intentionally omitted: at 192-bit entropy it adds key-
management burden for negligible gain, and it would break the zero-env property.
