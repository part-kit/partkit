# auth.session 1.0.0 → 1.1.0 — seam changes

**Additive minor. No breaking change. No migration required.**

- **Interface:** unchanged. OAuth / social sign-in is served by the existing
  `authHandler` catch-all (`/api/auth/[...all]`) — no new export, no route change.
- **Schema:** unchanged. The `auth_account` table already carries the OAuth
  columns (`providerId`, `accountId`, `accessToken`, `refreshToken`, `idToken`,
  `scope`), so enabling a social provider needs **no `partkit migrate` run**.
- **Env (additive, all optional):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. A provider turns on only when BOTH
  of its vars are set; with none set, behavior is byte-identical to 1.0.0
  (email/password only).
- **Behavior:** purely additive — email/password sign-up/in, sessions, guards,
  and `signOut` are unchanged.
