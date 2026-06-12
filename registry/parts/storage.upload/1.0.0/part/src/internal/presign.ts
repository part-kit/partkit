import { loadConfig, redactSecrets, type ResolvedConfig } from "./config.js";
import { StorageError } from "./errors.js";
import { computeSignature, formatAmzDate, uriEncode } from "./sigv4.js";
import type { PresignedRequest } from "./types.js";
import { resolveExpiry, validateKey } from "./validate.js";

function hostFor(cfg: ResolvedConfig): string {
  const defaultPort = cfg.scheme === "https" ? "443" : "80";
  const portPart = cfg.port !== "" && cfg.port !== defaultPort ? `:${cfg.port}` : "";
  // path-style: bucket lives in the path; virtual-hosted: bucket prefixes the host.
  return cfg.forcePathStyle
    ? `${cfg.hostname}${portPart}`
    : `${cfg.bucket}.${cfg.hostname}${portPart}`;
}

function canonicalUriFor(cfg: ResolvedConfig, key: string): string {
  return cfg.forcePathStyle
    ? `/${uriEncode(cfg.bucket, true)}/${uriEncode(key, false)}`
    : `/${uriEncode(key, false)}`;
}

/**
 * Build a presigned S3 request. Pure computation: no network, no throw on
 * import. Configuration and inputs are validated here, at call time, and any
 * error has secrets scrubbed (contract invariants 1, 7).
 */
export function buildPresigned(
  method: "PUT" | "GET",
  key: string,
  expiresInSeconds: number | undefined,
): PresignedRequest {
  try {
    const cfg = loadConfig();
    validateKey(key);
    const expires = resolveExpiry(expiresInSeconds);

    const now = new Date();
    const amzDate = formatAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;

    const host = hostFor(cfg);
    const canonicalUri = canonicalUriFor(cfg, key);

    // Canonical query: fixed, alphabetically ordered, every part encoded.
    const params: [string, string][] = [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${cfg.accessKeyId}/${scope}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(expires)],
      ["X-Amz-SignedHeaders", "host"],
    ];
    const canonicalQuery = params
      .map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(v, true)}`)
      .join("&");

    const signature = computeSignature({
      method,
      canonicalUri,
      canonicalQuery,
      host,
      amzDate,
      region: cfg.region,
      secretAccessKey: cfg.secretAccessKey,
    });

    const url = `${cfg.scheme}://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    return {
      url,
      method,
      headers: {},
      expiresAt: new Date(now.getTime() + expires * 1000),
    };
  } catch (e) {
    if (e instanceof StorageError) throw new StorageError(e.code, redactSecrets(e.message));
    throw new StorageError("config", redactSecrets(e instanceof Error ? e.message : String(e)));
  }
}
