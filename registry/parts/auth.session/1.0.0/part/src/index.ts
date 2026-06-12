/**
 * auth.session — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 */
import {
  firstCookiePair,
  getAuth,
  mapAuthFailure,
  statusOf,
  toSessionResult,
} from "./internal/auth";
import { redactSecrets } from "./internal/config";
import { AuthError } from "./internal/errors";
import type {
  AuthResult,
  SessionResult,
  SignInInput,
  SignUpInput,
} from "./internal/types";

export { AuthError } from "./internal/errors";
export type { AuthErrorCode } from "./internal/errors";
export type {
  AuthResult,
  AuthSession,
  AuthUser,
  SessionResult,
  SignInInput,
  SignUpInput,
} from "./internal/types";

/**
 * Mount as the auth catch-all route (`app/api/auth/[...all]/route.ts`):
 *   export const { GET, POST } = { GET: authHandler, POST: authHandler };
 * This is how the Better Auth client (browser) signs in/out and reads sessions;
 * cookies are managed for you. Constructing it performs no I/O (invariant 6).
 */
export async function authHandler(request: Request): Promise<Response> {
  try {
    return await getAuth().handler(request);
  } catch (e) {
    throw new AuthError("auth", redactSecrets(e instanceof Error ? e.message : String(e)));
  }
}

/** Resolve the signed-in user+session from request headers, or null. */
export async function getSession(headers: Headers): Promise<SessionResult | null> {
  try {
    const raw = await getAuth().api.getSession({ headers });
    return toSessionResult(raw);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError("auth", redactSecrets(e instanceof Error ? e.message : String(e)));
  }
}

/** Like getSession, but throws AuthError("unauthenticated") when there is none. */
export async function requireSession(headers: Headers): Promise<SessionResult> {
  const session = await getSession(headers);
  if (session === null) throw new AuthError("unauthenticated", "Authentication required");
  return session;
}

async function establish(
  context: "signup" | "signin",
  run: () => Promise<Response>,
): Promise<AuthResult> {
  let res: Response;
  try {
    res = await run();
  } catch (e) {
    if (e instanceof AuthError) throw e;
    const status = statusOf(e);
    if (status !== null) throw mapAuthFailure(status, context);
    throw new AuthError("auth", redactSecrets(e instanceof Error ? e.message : String(e)));
  }
  if (!res.ok) throw mapAuthFailure(res.status, context);

  const setCookie = res.headers.get("set-cookie") ?? "";
  const session = await getSession(new Headers({ cookie: firstCookiePair(setCookie) }));
  if (session === null) throw new AuthError("auth", `${context} did not establish a session`);
  return { ...session, setCookie };
}

/**
 * Create an account and an active session. Returns the session and the
 * `Set-Cookie` to attach to your response (the browser flow via authHandler
 * sets it automatically; this is for server-side sign-up). A duplicate email
 * fails with AuthError("email_taken"); the password is stored only hashed
 * (contract invariant 2).
 */
export async function signUp(input: SignUpInput): Promise<AuthResult> {
  return establish("signup", () =>
    getAuth().api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
      asResponse: true,
    }),
  );
}

/**
 * Verify credentials and establish a session. An unknown email or a wrong
 * password both fail with AuthError("invalid_credentials") and the same
 * message — no account enumeration (contract invariant 3).
 */
export async function signIn(input: SignInInput): Promise<AuthResult> {
  return establish("signin", () =>
    getAuth().api.signInEmail({
      body: { email: input.email, password: input.password },
      asResponse: true,
    }),
  );
}

/** Invalidate the session referenced by the request's cookie (invariant 5). */
export async function signOut(headers: Headers): Promise<void> {
  try {
    await getAuth().api.signOut({ headers });
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError("auth", redactSecrets(e instanceof Error ? e.message : String(e)));
  }
}
