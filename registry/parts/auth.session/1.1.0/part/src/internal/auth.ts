import { APIError, betterAuth } from "better-auth";
import { Pool } from "pg";
import { loadConfig, optionalEnv } from "./config";
import { AuthError, type AuthErrorCode } from "./errors";
import type { AuthSession, AuthUser, SessionResult } from "./types";

/**
 * Module-scope singletons, built lazily on first use and re-created per cold
 * start — the only sanctioned long-lived state under serverless (docs/02 §2).
 * Importing the part never touches the network or the database; the pool and
 * the Better Auth instance come into being only when an export is first called.
 */
let pool: Pool | null = null;

/**
 * OAuth providers are SEAMS, not registry adapters (docs/02): each is enabled
 * iff BOTH its client id + secret env vars are set, so an app turns on Google
 * / GitHub sign-in by providing credentials — no code change, no new export
 * (Better Auth's catch-all handler already serves /sign-in/social and
 * /callback/:provider). The auth_account table already carries the OAuth
 * columns, so this is purely additive over 1.0.0.
 */
function socialProviders(): Record<string, { clientId: string; clientSecret: string }> {
  const out: Record<string, { clientId: string; clientSecret: string }> = {};
  const googleId = optionalEnv("GOOGLE_CLIENT_ID");
  const googleSecret = optionalEnv("GOOGLE_CLIENT_SECRET");
  if (googleId !== null && googleSecret !== null) out["google"] = { clientId: googleId, clientSecret: googleSecret };
  const githubId = optionalEnv("GITHUB_CLIENT_ID");
  const githubSecret = optionalEnv("GITHUB_CLIENT_SECRET");
  if (githubId !== null && githubSecret !== null) out["github"] = { clientId: githubId, clientSecret: githubSecret };
  return out;
}

function buildAuth() {
  const cfg = loadConfig();
  pool = new Pool({ connectionString: cfg.databaseUrl });
  return betterAuth({
    database: pool,
    secret: cfg.secret,
    baseURL: cfg.baseUrl,
    emailAndPassword: { enabled: true },
    // OAuth providers enabled by env (a seam, not an adapter) — empty when none set.
    socialProviders: socialProviders(),
    // No surprise network I/O from a vendored part.
    telemetry: { enabled: false },
    // Part-owned, auth_-prefixed tables (docs/02 §6). The migration creates
    // exactly these; Better Auth reads/writes them via this mapping.
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session" },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
  });
}

type AuthInstance = ReturnType<typeof buildAuth>;
let authInstance: AuthInstance | null = null;

export function getAuth(): AuthInstance {
  if (authInstance !== null) return authInstance;
  authInstance = buildAuth();
  return authInstance;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** Map Better Auth's session+user payload to the part's stable shape. */
export function toSessionResult(raw: unknown): SessionResult | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as { session?: Record<string, unknown>; user?: Record<string, unknown> };
  if (r.session === undefined || r.user === undefined) return null;
  const s = r.session;
  const u = r.user;
  const session: AuthSession = {
    id: String(s["id"]),
    userId: String(s["userId"]),
    token: String(s["token"]),
    expiresAt: toDate(s["expiresAt"]),
    createdAt: toDate(s["createdAt"]),
  };
  const user: AuthUser = {
    id: String(u["id"]),
    email: String(u["email"]),
    name: String(u["name"]),
    emailVerified: Boolean(u["emailVerified"]),
    image: u["image"] === null || u["image"] === undefined ? null : String(u["image"]),
    createdAt: toDate(u["createdAt"]),
    updatedAt: toDate(u["updatedAt"]),
  };
  return { user, session };
}

/** The `name=value` pair from a Set-Cookie header, without attributes. */
export function firstCookiePair(setCookie: string | null): string {
  if (setCookie === null || setCookie === "") return "";
  return setCookie.split(";", 1)[0] ?? "";
}

/**
 * Translate a Better Auth failure into a typed AuthError. Both an unknown email
 * and a wrong password map to `invalid_credentials` with one message — no
 * account enumeration (contract invariant 3).
 */
export function mapAuthFailure(status: number, context: "signup" | "signin"): AuthError {
  let code: AuthErrorCode;
  if (status === 401 || status === 403) code = "invalid_credentials";
  else if (status === 409 || status === 422) code = context === "signup" ? "email_taken" : "invalid_credentials";
  else if (status === 400) code = "invalid_input";
  else code = "auth";
  const message =
    code === "invalid_credentials"
      ? "Invalid email or password"
      : code === "email_taken"
        ? "An account with this email already exists"
        : code === "invalid_input"
          ? "Invalid sign-up details"
          : "Authentication failed";
  return new AuthError(code, message);
}

/** Status code from either an asResponse Response or a thrown APIError. */
export function statusOf(e: unknown): number | null {
  if (e instanceof APIError) {
    const s = (e as { statusCode?: unknown }).statusCode;
    return typeof s === "number" ? s : 500;
  }
  return null;
}
