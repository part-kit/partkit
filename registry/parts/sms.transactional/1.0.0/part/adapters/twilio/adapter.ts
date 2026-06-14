/**
 * Twilio adapter — POST the Messages REST endpoint with HTTP Basic auth.
 * ZERO npm dependencies: the supply chain is this file + node's fetch. The
 * "easy / more expensive" vendor an agent reaches for; the flip to amazon-sns is
 * one command (`partkit upgrade sms.transactional --adapter=amazon-sns`).
 * API: https://www.twilio.com/docs/sms/api/message-resource#create-a-message
 */
import { Buffer } from "node:buffer";
import { optionalEnv, requireEnv } from "../../src/internal/config";
import { SmsError, vendorHttpError, vendorNetworkError } from "../../src/internal/errors";
import type { AdapterSendOutput, NormalizedSms, SmsAdapter } from "../../src/internal/types";

const DEFAULT_BASE_URL = "https://api.twilio.com";

async function sendViaTwilio(message: NormalizedSms): Promise<AdapterSendOutput> {
  const sid = requireEnv("TWILIO_ACCOUNT_SID");
  const token = requireEnv("TWILIO_AUTH_TOKEN");
  const sender = message.from ?? optionalEnv("TWILIO_FROM");
  if (sender === null) {
    throw new SmsError(
      "config",
      "twilio needs a sender — pass message.from or set TWILIO_FROM (a number or Messaging Service SID)",
      { retryable: false },
    );
  }
  // Base-URL override exists for the conformance fakes; never set it in production (SPEC.md).
  const baseUrl = optionalEnv("TWILIO_BASE_URL") ?? DEFAULT_BASE_URL;

  const form = new URLSearchParams({ To: message.to, Body: message.body });
  // A Messaging Service SID (MG…) rides MessagingServiceSid; a plain number, From.
  if (sender.startsWith("MG")) form.set("MessagingServiceSid", sender);
  else form.set("From", sender);

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (e) {
    throw vendorNetworkError("twilio", e);
  }

  // Error bodies are intentionally unread — raw vendor responses never escape (invariant 5).
  if (!res.ok) throw vendorHttpError("twilio", res.status);

  const data = (await res.json().catch(() => ({}))) as { sid?: unknown };
  return { id: typeof data.sid === "string" ? data.sid : "unknown" };
}

export const adapter: SmsAdapter = { name: "twilio", send: sendViaTwilio };
