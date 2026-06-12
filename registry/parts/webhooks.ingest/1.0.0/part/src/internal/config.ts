import { WebhookError } from "./errors.js";

/** Env vars that hold secrets — the redaction list (contract invariant 6). */
export const SECRET_ENV_VARS = ["WEBHOOK_SECRET"] as const;

export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * All configuration is read lazily, at call time — importing the part
 * performs no I/O and never throws (contract invariant 1, serverless-safe).
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new WebhookError(
      "config",
      `Missing required env var ${name} — see parts/webhooks.ingest/seams.md`,
    );
  }
  return value;
}

export function toleranceSeconds(): number {
  const raw = process.env["WEBHOOK_TOLERANCE_SECONDS"];
  if (raw === undefined || raw === "") return DEFAULT_TOLERANCE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new WebhookError(
      "config",
      `WEBHOOK_TOLERANCE_SECONDS must be a positive integer of seconds, got "${raw}"`,
    );
  }
  return parsed;
}
