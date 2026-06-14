import { UsageError } from "./errors";

/** Env vars that hold secrets — the redaction list (contract invariant 6). */
export const SECRET_ENV_VARS = ["BILLING_USAGE_SECRET_KEY"] as const;

export interface ResolvedConfig {
  secretKey: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new UsageError("config", `Missing required env var ${name} — see parts/billing.usage/seams.md`);
  }
  return value;
}

/**
 * Read configuration lazily, at first biller use — importing the part performs
 * no I/O and never throws (contract invariant 1). Only the reporting half (the
 * Stripe adapter) needs this; the ledger (record/total/summary) reads no env.
 */
export function loadConfig(): ResolvedConfig {
  return { secretKey: requireEnv("BILLING_USAGE_SECRET_KEY") };
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
