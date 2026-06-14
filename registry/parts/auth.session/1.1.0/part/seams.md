# Seams — auth.session

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested
interior; edits void the attestation and fail CI).

## 1. Environment

`partkit add` scaffolds these into `.env.example`:

| Var | Required | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | yes | **Secret.** Signs session cookies. Generate: `openssl rand -base64 32`. |
| `AUTH_DATABASE_URL` | yes | **Secret.** Postgres connection string for the auth tables. May be the same database as the rest of your app — the part only touches `auth_*` tables. |
| `BETTER_AUTH_URL` | yes | Your app's base URL, e.g. `http://localhost:3000` or `https://app.example.com`. Used for cookie domain and callback URLs. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Set both to enable Google sign-in (§5b). The secret is **Secret**. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | Set both to enable GitHub sign-in (§5b). The secret is **Secret**. |

```ts
import { authHandler, getSession, requireSession, AuthError } from "@parts/auth.session";
```

Never deep-import `src/internal/**` (lint-enforced).

## 2. Run the migration before first use

`partkit add auth.session` vendors
`parts/auth.session/migrations/001-create-auth-tables.sql`. Apply it:

```sh
partkit migrate     # creates auth_user, auth_session, auth_account, auth_verification
```

**Do NOT run Better Auth's own migrator / `@better-auth/cli migrate`.** The
schema is part-owned and applied by `partkit migrate` (which records the
`_part_migrations` ledger). The vendored migration was generated from Better
Auth's schema for exactly this part's config, so it matches what the interior
reads and writes.

## 3. Mount the auth route (the route seam) — Node.js runtime

The contract declares the catch-all `GET/POST /api/auth/[...all]`. Create
`app/api/auth/[...all]/route.ts` from `examples/auth-route.ts`:

```ts
import { authHandler } from "@parts/auth.session";
export const runtime = "nodejs";      // REQUIRED — the part uses `pg`, not Edge-safe
export const GET = authHandler;
export const POST = authHandler;
```

> **Runtime caveat:** every place you call into this part (the route above,
> and any `getSession`/`requireSession` call) must run on the **Node.js
> runtime**, never Edge — `pg` is not Edge-compatible. In particular, do not
> call `getSession` from Next.js *middleware* (it runs on Edge by default); do
> your session checks in route handlers, Server Components, or server actions.

## 4. Reading the session (server side)

```ts
const session = await getSession(headers);     // { user, session } | null
const { user } = await requireSession(headers); // throws AuthError("unauthenticated")
```

Pass the incoming request's `headers` (the browser sends the auth cookie). See
`examples/protect-page.ts`.

## 5. Signing in

- **Browser (recommended):** use Better Auth's client SDK
  (`createAuthClient({ baseURL: "/api/auth" })`) or POST to the mounted routes;
  cookies are set automatically by `authHandler`.
- **Server-side:** `signUp({ email, password, name })` / `signIn({ email,
  password })` return `{ user, session, setCookie }` — attach `setCookie` to
  your response to log the client in. `signOut(headers)` invalidates the
  session. An unknown email or wrong password both raise
  `AuthError("invalid_credentials")` with one message (no account enumeration).

## 5b. Social sign-in (OAuth) — a seam, not an adapter

Turn on a provider by setting its credentials; nothing else changes. A provider
is enabled **only when both** its vars are set, so you opt in per provider:

| Provider | Env (both required to enable) |
|---|---|
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |

The mounted `authHandler` (§3) then serves the provider routes automatically — no
new route, no code change. Start a sign-in by sending the browser to (or POSTing)
`…/api/auth/sign-in/social` with `{ provider: "google" }` (the Better Auth client
SDK's `signIn.social({ provider })` does exactly this), and set each provider's
**authorized redirect URI** in its console to
`<BETTER_AUTH_URL>/api/auth/callback/<provider>` (e.g.
`https://app.example.com/api/auth/callback/google`). The linked account lands in
`auth_account`; a returning OAuth user resolves through `getSession` exactly like
a password user. Provisioning the OAuth app (consent screen, redirect URI) is the
human's one-time step. No migration is needed — `auth_account` already has the
OAuth columns.

## 6. The tables are interior

`auth_user`, `auth_session`, `auth_account`, `auth_verification` are part-owned.
Read user/session data only through `getSession` — do not `SELECT` from
`auth_*` directly or write a migration that touches them; their columns are the
interior's contract, not yours, and can change across versions.

## 7. What you must NOT do

- Edit or import anything under `src/internal/**`.
- Run Better Auth's own migrator (§2).
- Use the Edge runtime for the auth route or session checks (§3).
- Send `BETTER_AUTH_SECRET` / `AUTH_DATABASE_URL` to the browser.
- `SELECT`/write `auth_*` tables directly (§6).

## 8. Not yet

Email verification and password reset compose on `email.transactional` and land
in a follow-up minor. (OAuth / social sign-in shipped in **1.1** — see §5b.)
