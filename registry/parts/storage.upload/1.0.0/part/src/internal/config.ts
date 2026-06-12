import { StorageError } from "./errors.js";

/** Env vars that hold secrets — the redaction list (contract invariant 7). */
export const SECRET_ENV_VARS = ["STORAGE_SECRET_ACCESS_KEY"] as const;

export interface ResolvedConfig {
  scheme: "http" | "https";
  /** host without port. */
  hostname: string;
  /** port, or "" when the scheme default. */
  port: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new StorageError("config", `Missing required env var ${name} — see parts/storage.upload/seams.md`);
  }
  return value;
}

/**
 * All configuration is read lazily, at call time — importing the part performs
 * no I/O and never throws (contract invariant 1). Secret values are scrubbed
 * from any message this throws by `redactSecrets` at the call site.
 */
export function loadConfig(): ResolvedConfig {
  const endpointRaw = requireEnv("STORAGE_ENDPOINT");
  let url: URL;
  try {
    url = new URL(endpointRaw);
  } catch {
    throw new StorageError("config", `STORAGE_ENDPOINT is not a valid URL: "${endpointRaw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new StorageError("config", `STORAGE_ENDPOINT must be http(s): "${endpointRaw}"`);
  }

  const forcePathRaw = process.env["STORAGE_FORCE_PATH_STYLE"];
  let forcePathStyle = true;
  if (forcePathRaw !== undefined && forcePathRaw !== "") {
    if (forcePathRaw !== "true" && forcePathRaw !== "false") {
      throw new StorageError(
        "config",
        `STORAGE_FORCE_PATH_STYLE must be "true" or "false", got "${forcePathRaw}"`,
      );
    }
    forcePathStyle = forcePathRaw === "true";
  }

  return {
    scheme: url.protocol === "https:" ? "https" : "http",
    hostname: url.hostname,
    port: url.port,
    region: requireEnv("STORAGE_REGION"),
    bucket: requireEnv("STORAGE_BUCKET"),
    accessKeyId: requireEnv("STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("STORAGE_SECRET_ACCESS_KEY"),
    forcePathStyle,
  };
}

/**
 * Strip secret env values out of a string before it escapes inside an error
 * (contract invariant 7). The access key id is intentionally NOT redacted — it
 * is a public identifier that legitimately appears in the URL credential.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined && value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out;
}
