import process from "node:process";
import { BillingError } from "./errors";

/** Env values that must never appear in an error message or log. */
export const SECRET_ENV_VARS = ["BILLING_SECRET_KEY", "BILLING_WEBHOOK_SECRET"] as const;

export interface ResolvedConfig {
  /** Stripe secret key (sk_test_… / sk_live_…). */
  secretKey: string;
  /** Stripe webhook signing secret (whsec_…). */
  webhookSecret: string;
}

/** Read a required env var; blank or unset fails fast with a typed config error. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new BillingError("config", `${name} is required but not set — see seams.md`);
  }
  return v;
}

/** No I/O — just reads env. Called lazily on first use, never at import. */
export function loadConfig(): ResolvedConfig {
  return {
    secretKey: requireEnv("BILLING_SECRET_KEY"),
    webhookSecret: requireEnv("BILLING_WEBHOOK_SECRET"),
  };
}

/**
 * Replace every configured secret value with [redacted]. Guarded at length ≥ 4
 * so an accidentally-short/empty secret can't blank out unrelated text. Apply at
 * every throw site that may include a vendor/driver message.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const v = process.env[name];
    if (v !== undefined && v.length >= 4) {
      out = out.split(v).join("[redacted]");
    }
  }
  return out;
}
