import { EmailError } from "./errors";
import type { EmailAddress } from "./types";

/** Env vars that hold secrets — the redaction list (contract invariant 6). */
export const SECRET_ENV_VARS = ["RESEND_API_KEY", "POSTMARK_SERVER_TOKEN"] as const;

/**
 * All configuration is read lazily, at call time — importing the part
 * performs no I/O and never throws (contract invariant 1, serverless-safe).
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new EmailError(
      "config",
      `Missing required env var ${name} — see parts/email.transactional/seams.md`,
      { retryable: false },
    );
  }
  return value;
}

export function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

const FROM_RE = /^(?:([^<>\r\n]+)\s)?<?([^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+)>?$/;

/** Accepts `hello@acme.com` or `Acme <hello@acme.com>`. */
export function parseFromAddress(raw: string): EmailAddress {
  const match = FROM_RE.exec(raw.trim());
  const email = match?.[2];
  if (email === undefined) {
    throw new EmailError(
      "config",
      `EMAIL_FROM is not a valid address — expected "you@domain.com" or "Name <you@domain.com>"`,
      { retryable: false },
    );
  }
  const name = match?.[1]?.trim();
  return name !== undefined && name !== "" ? { email, name } : { email };
}
