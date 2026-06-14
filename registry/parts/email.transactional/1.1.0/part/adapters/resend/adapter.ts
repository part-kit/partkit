/**
 * Resend adapter — speaks the vendor REST API directly. Zero npm dependencies:
 * the entire supply chain of this adapter is this file plus node's fetch.
 * API: https://resend.com/docs/api-reference/emails/send-email
 */
import { optionalEnv, requireEnv } from "../../src/internal/config";
import { vendorHttpError, vendorNetworkError } from "../../src/internal/errors";
import type {
  AdapterSendInput,
  AdapterSendOutput,
  EmailAdapter,
  EmailAddress,
} from "../../src/internal/types";

const DEFAULT_BASE_URL = "https://api.resend.com";

function format(addr: EmailAddress): string {
  return addr.name !== undefined ? `${addr.name} <${addr.email}>` : addr.email;
}

async function sendViaResend(input: AdapterSendInput): Promise<AdapterSendOutput> {
  const apiKey = requireEnv("RESEND_API_KEY");
  // Base-URL override exists for the conformance fakes; never set it in production (SPEC.md).
  const baseUrl = optionalEnv("RESEND_BASE_URL") ?? DEFAULT_BASE_URL;
  const { from, message } = input;

  const body: Record<string, unknown> = {
    from: format(from),
    to: message.to.map(format),
    subject: message.subject,
  };
  if (message.html !== null) body["html"] = message.html;
  if (message.text !== null) body["text"] = message.text;
  if (message.replyTo !== null) body["reply_to"] = format(message.replyTo);
  if (Object.keys(message.headers).length > 0) body["headers"] = message.headers;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(message.idempotencyKey !== null && { "Idempotency-Key": message.idempotencyKey }),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw vendorNetworkError("resend", e);
  }

  // Error bodies are intentionally unread — raw vendor responses never escape (invariant 5).
  if (!res.ok) throw vendorHttpError("resend", res.status);

  const data = (await res.json().catch(() => ({}))) as { id?: unknown };
  return { id: typeof data.id === "string" ? data.id : "unknown" };
}

export const adapter: EmailAdapter = { name: "resend", send: sendViaResend };
