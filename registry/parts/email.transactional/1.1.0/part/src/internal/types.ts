export interface EmailAddress {
  email: string;
  name?: string;
}

/** Public input shape — re-exported by index.ts. */
export interface EmailMessage {
  to: EmailAddress | EmailAddress[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: EmailAddress;
  headers?: Record<string, string>;
  /** Passed to vendors that support idempotent sends (Resend). */
  idempotencyKey?: string;
}

/** Validated, normalized form every adapter receives. */
export interface NormalizedMessage {
  to: EmailAddress[];
  subject: string;
  html: string | null;
  text: string | null;
  replyTo: EmailAddress | null;
  headers: Record<string, string>;
  idempotencyKey: string | null;
}

export interface AdapterSendInput {
  from: EmailAddress;
  message: NormalizedMessage;
}

export interface AdapterSendOutput {
  /** Vendor-assigned message id. */
  id: string;
}

/**
 * Every adapter implements this. Adapters are interior code: they may import
 * src/internal/*, they read their own env lazily, and they throw only typed
 * errors built from errors.ts helpers.
 */
export interface EmailAdapter {
  readonly name: string;
  send(input: AdapterSendInput): Promise<AdapterSendOutput>;
}
