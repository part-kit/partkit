/** Header shapes accepted at the seam: Web-standard Headers or a plain record. */
export type WebhookHeaders =
  | Headers
  | Record<string, string | string[] | undefined>;

/** Public input shape — re-exported by index.ts. */
export interface WebhookRequest {
  /**
   * The RAW body exactly as received — `await req.text()` in an App Router
   * handler, never a parsed-then-re-serialized object (contract invariant 5).
   */
  payload: string | Uint8Array;
  headers: WebhookHeaders;
}

/** Public output shape — what a verified delivery exposes. */
export interface VerifiedWebhook {
  /** Vendor delivery id when the scheme carries one, else derived from the signature. */
  id: string;
  /** The SIGNED timestamp — trustworthy, unlike anything inside the payload. */
  timestamp: Date;
  /** Raw payload as a UTF-8 string; parsing it is the app's job (seams.md). */
  payload: string;
  /** Adapter that performed the verification. */
  adapter: string;
}

export type Unsubscribe = () => void;

/** Lowercased, first-value-wins header map every adapter receives. */
export type NormalizedHeaders = Record<string, string>;

export interface AdapterVerifyInput {
  /** Raw payload bytes as received. */
  payload: Buffer;
  headers: NormalizedHeaders;
  /** WEBHOOK_SECRET, verbatim; the adapter owns any decoding (whsec_ base64 etc). */
  secret: string;
  nowEpochSeconds: number;
  toleranceSeconds: number;
}

export interface AdapterVerifyOutput {
  /** Vendor delivery id when the scheme carries one, else derived from the signature. */
  id: string;
  /** The signed timestamp the adapter validated against the window. */
  timestampEpochSeconds: number;
  /** The signature that matched — the core derives the replay key from it. */
  matchedSignature: Buffer;
}

/**
 * Every adapter implements this. Adapters are interior code: they may import
 * src/internal/*, they parse their scheme's headers, and they throw only
 * WebhookError. Signature comparison MUST go through timingSafeEqualBuffers
 * and window checks through assertWithinWindow (src/internal/crypto.ts) so
 * the security-critical primitives exist exactly once.
 */
export interface WebhookAdapter {
  readonly name: string;
  verify(input: AdapterVerifyInput): AdapterVerifyOutput;
}
