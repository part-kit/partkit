import { SmsError } from "./errors";
import type { NormalizedSms, SmsMessage } from "./types";

// E.164: a leading + then 1–15 digits, first digit non-zero. (\+ and \d are not
// JSON string escapes, so this literal survives transport intact.)
const E164_RE = /^\+[1-9]\d{1,14}$/;
const MAX_BODY = 1600; // ~10 GSM-7 segments — a sane upper bound, not a hard vendor cap

function invalid(detail: string): SmsError {
  return new SmsError("invalid_message", detail, { retryable: false });
}

/** Reject C0/C1 controls and DEL. `allowNewlines` keeps \t \n \r (legitimate in
 *  a message body) but never in a sender identity. Implemented over char codes
 *  so the source carries no literal control characters. */
function hasDisallowedControl(s: string, allowNewlines: boolean): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (allowNewlines && (c === 9 || c === 10 || c === 13)) continue; // tab, LF, CR
    if (c < 32 || (c >= 127 && c <= 159)) return true;
  }
  return false;
}

/**
 * Validate and normalize before any network I/O: an invalid message fails fast
 * with zero vendor calls (invariant 2); the recipient must be E.164 and the body
 * non-empty and free of disallowed control characters (invariant 3).
 */
export function normalizeMessage(message: SmsMessage): NormalizedSms {
  if (message === null || typeof message !== "object") throw invalid("a message object is required");
  if (typeof message.to !== "string" || !E164_RE.test(message.to)) {
    throw invalid('recipient "to" must be E.164 (e.g. +15551234567)');
  }
  if (typeof message.body !== "string" || message.body === "") {
    throw invalid("body is required and must be a non-empty string");
  }
  if (message.body.length > MAX_BODY) throw invalid(`body exceeds ${MAX_BODY} characters`);
  if (hasDisallowedControl(message.body, true)) {
    throw invalid("body contains disallowed control characters");
  }

  let from: string | null = null;
  if (message.from !== undefined && message.from !== null) {
    if (typeof message.from !== "string" || message.from === "") throw invalid("from must be a non-empty string");
    if (hasDisallowedControl(message.from, false)) throw invalid("from contains disallowed characters");
    from = message.from;
  }

  return { to: message.to, body: message.body, from };
}
