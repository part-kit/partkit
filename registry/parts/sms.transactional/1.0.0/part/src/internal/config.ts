import process from "node:process";
import { SmsError } from "./errors";

/** Env vars that hold secrets — the redaction list (contract invariant 6). */
export const SECRET_ENV_VARS = ["TWILIO_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY"] as const;

/**
 * All configuration is read lazily, at call time — importing the part performs
 * no I/O and never throws (contract invariant 1, serverless-safe).
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new SmsError("config", `Missing required env var ${name} — see parts/sms.transactional/seams.md`, {
      retryable: false,
    });
  }
  return value;
}

export function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}
