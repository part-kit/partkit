import { AuthError } from "./errors";

/** Env vars that hold secrets — the redaction list (contract invariant 7). */
export const SECRET_ENV_VARS = ["BETTER_AUTH_SECRET", "AUTH_DATABASE_URL", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_SECRET"] as const;

export interface ResolvedConfig {
  secret: string;
  databaseUrl: string;
  baseUrl: string;
}

export function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new AuthError("config", `Missing required env var ${name} — see parts/auth.session/seams.md`);
  }
  return value;
}

/**
 * Read configuration lazily, at first use — importing the part performs no I/O
 * and never throws (contract invariant 1). Secrets are scrubbed from any
 * message this throws by `redactSecrets` at the call site.
 */
export function loadConfig(): ResolvedConfig {
  return {
    secret: requireEnv("BETTER_AUTH_SECRET"),
    databaseUrl: requireEnv("AUTH_DATABASE_URL"),
    baseUrl: requireEnv("BETTER_AUTH_URL"),
  };
}

/** Strip secret env values out of a string before it escapes in an error. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined && value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out;
}
