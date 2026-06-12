import { SECRET_ENV_VARS } from "./config.js";

/**
 * Strip any secret env values out of a string before it can escape the part
 * inside an error message (contract invariant 6). Length guard avoids
 * degenerate redaction when a secret is set to something trivially short.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined && value.length >= 4) {
      out = out.split(value).join("[redacted]");
    }
  }
  return out;
}
