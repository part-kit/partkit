/** Public input shape — re-exported by index.ts. Numbers are E.164 (e.g. +15551234567). */
export interface SmsMessage {
  /** Recipient, E.164 format. */
  to: string;
  /** The message text. */
  body: string;
  /**
   * Sender. The twilio adapter uses this (or `TWILIO_FROM`) as the From number /
   * Messaging Service SID. The amazon-sns adapter ignores it and relies on the
   * account's provisioned origination identity (see seams.md).
   */
  from?: string;
}

/** Validated, normalized form every adapter receives. */
export interface NormalizedSms {
  to: string;
  body: string;
  from: string | null;
}

export interface AdapterSendOutput {
  /** Vendor-assigned message id. */
  id: string;
}

/**
 * Every adapter implements this. Adapters are interior code: they may import
 * src/internal/*, read their own env lazily, and throw only typed errors built
 * from errors.ts helpers.
 */
export interface SmsAdapter {
  readonly name: string;
  send(message: NormalizedSms): Promise<AdapterSendOutput>;
}
