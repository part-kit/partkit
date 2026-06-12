/** A presigned request the caller hands to a browser or HTTP client. */
export interface PresignedRequest {
  /** The full presigned URL — open it with `method` and the bytes. */
  url: string;
  /** PUT for an upload, GET for a download. */
  method: "PUT" | "GET";
  /**
   * Headers the client MUST send for the signature to verify. In v1 only
   * `host` is signed (set automatically by every HTTP client), so this is
   * empty — present so callers can spread it unconditionally and so signed
   * headers can be added in a future minor without a breaking change.
   */
  headers: Record<string, string>;
  /** When the URL stops working. */
  expiresAt: Date;
}

export interface PresignUploadOptions {
  /** Seconds the URL stays valid: 1..604800 (7 days), default 900. */
  expiresInSeconds?: number;
}

export interface PresignDownloadOptions {
  /** Seconds the URL stays valid: 1..604800 (7 days), default 900. */
  expiresInSeconds?: number;
}
