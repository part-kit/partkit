# auth.session — SPEC

Email/password authentication and server-validated sessions behind a
contract-stable interface, wrapping Better Auth over part-owned tables. 1.0 scope
was **email/password + sessions + guards**; **1.1 adds OAuth / social sign-in**
(Google, GitHub) as an additive minor — providers are seams configured by env, no
new export, no migration (the `auth_account` table already carries the OAuth
columns).

## Design decisions

- **Wrap Better Auth; don't reimplement auth.** Password hashing, session
  management, cookie signing, and CSRF defenses are exactly the security-
  critical code PartKit's thesis says to attest-and-contract rather than
  rewrite (docs/02 §1). This is the first part to declare `npm_dependencies`
  (RFC 0001, `contract_version 0.2`): `better-auth` (the wrapped library) and
  `pg` (the Postgres driver its bundled Kysely adapter uses). Nothing else.
- **A second auth library would be a second part, not an adapter.** The library
  is interior, not an adapter axis — interchangeability is at the capability
  level (another part can later provide `auth.session@1`). Variety the app
  actually configures (OAuth providers) arrives as seams. So this part ships
  **zero registry adapters**.
- **OAuth providers are seams, enabled by env — added in 1.1 (additive).** A
  provider (`google`, `github`) is configured iff BOTH its client id + secret env
  vars are set; `buildAuth` passes them to Better Auth's `socialProviders`, and
  the existing `authHandler` catch-all already serves `/sign-in/social` and
  `/callback/:provider` — so OAuth needs no new export and no route change. The
  `auth_account` table already has the OAuth columns (`providerId`, `accountId`,
  `accessToken`, …), so no migration runs. With no provider env set, behavior is
  byte-identical to 1.0. The client secrets join the redaction list.
- **Part-owned `auth_*` tables, applied by `partkit migrate`.** Better Auth's
  default tables (`user`, `session`, …) would break the docs/02 §6 prefix rule
  and collide with the app's own `user` table. The part maps every model to an
  `auth_`-prefixed table via Better Auth's `modelName` config, and ships
  `migrations/001` **generated from Better Auth's own schema generator**
  (`getMigrations().compileMigrations()`) for this exact config — so the SQL
  matches the interior byte-for-byte. `partkit migrate` owns the ledger; Better
  Auth's runtime migrator is never used.
- **Lazy, memoized instance.** Importing performs no I/O and never throws; the
  `pg` Pool and the Better Auth instance are built on first call and re-created
  per cold start (the sanctioned long-lived form under serverless, docs/02 §2).
  Telemetry is disabled — a vendored part makes no surprise network calls.
- **Typed errors, no library leakage, no enumeration.** Better Auth's internal
  `APIError` values are translated to stable `AuthError` codes; an unknown
  email and a wrong password both yield `invalid_credentials` with one message.
  Secrets are scrubbed from every error.
- **Node.js runtime only.** `pg` is not Edge-compatible, so the mounted route
  and all session reads run on Node — called out prominently in seams.md
  because the Next.js default for middleware is Edge.

## Invariant → conformance test mapping

| # | Invariant (contract.json) | Test (conformance/auth.test.ts) |
|---|---|---|
| 1 | No import I/O; config validated lazily, typed errors | "invariant 1: missing config is a typed error…" |
| 2 | signUp persists user+session, hashes password, rejects dup | "invariant 2: signUp persists…" |
| 3 | signIn issues session; bad creds → one typed error, no enumeration | "invariant 3: signIn issues a session…" |
| 4 | getSession valid/null; requireSession throws when absent | "invariant 4: getSession resolves…" |
| 5 | signOut invalidates the session | "invariant 5: signOut invalidates…" |
| 6 | authHandler is a mountable fetch handler | "invariant 6: authHandler is a mountable…" |
| 7 | Typed errors only; secrets never in messages | "invariant 7: a config error never leaks the secret" |
| 8 | Social sign-in opt-in by env; unconfigured provider rejected | "invariant 8: a configured social provider (google)…", "invariant 8: an UNCONFIGURED social provider (github)…" |

Invariants 1 and 7 run DB-free; 2–6 and 8 run against real Better Auth + real
Postgres (gated on `PARTKIT_TEST_DATABASE_URL`), using the part's own migration.
The OAuth tests assert the locally-built provider consent URL (no network: Better
Auth constructs the redirect URL itself, so the flow is testable offline) and that
an unconfigured provider is refused.

## Threat model

- **Password handling.** Passwords are hashed by Better Auth (scrypt) and
  stored only in `auth_account.password`; conformance asserts the stored value
  is not the plaintext. The part never sees or logs raw passwords beyond
  passing them to the library.
- **Account enumeration.** Sign-in failures (unknown email vs wrong password)
  return one code and one message, so an attacker cannot probe which emails
  exist.
- **OAuth provider trust + redirect.** A social provider is enabled only when its
  server-side secret is present, so one can't be silently turned on; an
  unconfigured provider is rejected (conformance-tested), never silently
  attempted. Better Auth performs the authorization-code exchange and validates
  the callback `state` (CSRF); the app registers the exact
  `BETTER_AUTH_URL/api/auth/callback/<provider>` redirect URI per provider.
  Provider client secrets are scrubbed from error messages.
- **Session integrity.** Sessions are server-side rows keyed by a signed cookie
  token; `signOut` deletes the row so the cookie no longer resolves
  (conformance-tested). Tokens are opaque and never reconstructable from the
  returned `AuthSession`.
- **Secret exposure.** `BETTER_AUTH_SECRET` and `AUTH_DATABASE_URL` are read
  lazily from server env, never sent to the client, and scrubbed from error
  messages. The seams doc forbids client-side use.
- **SQL injection.** All database access goes through Better Auth's Kysely
  adapter (parameterized); the part builds no SQL strings from input.
- **Runtime misuse.** Running on Edge would either fail (`pg` unavailable) or
  tempt insecure workarounds; the Node-runtime requirement is documented and
  the example pins `export const runtime = "nodejs"`.
- **CSRF / cookies.** Inherited from Better Auth's defaults (same-site cookies,
  origin checks); `BETTER_AUTH_URL` configures the trusted origin.

## Roadmap

- ✅ `1.1` (shipped, additive): OAuth / social sign-in — Google + GitHub as
  env-configured seams (not registry adapters); the `auth_account` table already
  carried the provider columns, so no migration. More providers are additive.
- Email verification + password reset, composing on `email.transactional`
  (the app provides the send seam).
- 2FA / passkeys via Better Auth plugins, behind additive contract surface.
- When a second provider appears, the suite and capability move to the
  namespace (docs/02 §3-4).

## Note: strict-gate `skipLibCheck`

This is the registry's first OSS-wrapping part. Better Auth's published type
declarations reference DOM/runtime types (`CryptoKey`, `RequestCache`, …) and
optional modules (`bun:sqlite`, `@cloudflare/workers-types`) that do not
resolve under the strict gate's `--lib es2023 --types node`. The part's own
source is fully strict-clean; type-checking *third-party declarations* is what
trips. The conformance and publish gate therefore require `--skipLibCheck`
(which skips only `node_modules` `.d.ts`, never the part's code) — see the
hand-off note in the commit body / final report.
