import { EmailError } from "./errors.js";
import type { EmailAddress, EmailMessage, NormalizedMessage } from "./types.js";

const CRLF_RE = /[\r\n]/;
const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

function invalid(detail: string): EmailError {
  return new EmailError("invalid_message", detail, { retryable: false });
}

function checkAddress(addr: EmailAddress, label: string): void {
  if (!EMAIL_RE.test(addr.email)) {
    throw invalid(`${label} address is not a valid email: "${addr.email}"`);
  }
  if (addr.name !== undefined && CRLF_RE.test(addr.name)) {
    throw invalid(`${label} display name contains line breaks (header-injection defense)`);
  }
}

/**
 * Validate and normalize before any network I/O: invalid messages fail fast
 * with zero vendor calls (invariant 2), and CR/LF anywhere near a header is
 * rejected outright (invariant 3 — header-injection defense).
 */
export function normalizeMessage(message: EmailMessage): NormalizedMessage {
  const to = Array.isArray(message.to) ? message.to : [message.to];
  if (to.length === 0) throw invalid("at least one recipient is required");
  for (const addr of to) checkAddress(addr, "recipient");
  if (message.replyTo !== undefined) checkAddress(message.replyTo, "replyTo");

  if (message.subject.trim() === "") throw invalid("subject is required");
  if (CRLF_RE.test(message.subject)) {
    throw invalid("subject contains line breaks (header-injection defense)");
  }

  const html = message.html ?? null;
  const text = message.text ?? null;
  if (html === null && text === null) throw invalid("provide html, text, or both");

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.headers ?? {})) {
    if (CRLF_RE.test(key) || CRLF_RE.test(value)) {
      throw invalid(`custom header "${key}" contains line breaks (header-injection defense)`);
    }
    headers[key] = value;
  }

  return {
    to,
    subject: message.subject,
    html,
    text,
    replyTo: message.replyTo ?? null,
    headers,
    idempotencyKey: message.idempotencyKey ?? null,
  };
}
