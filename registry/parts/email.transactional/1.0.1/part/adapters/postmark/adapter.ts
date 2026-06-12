/**
 * Postmark adapter — speaks the vendor REST API directly. Zero npm
 * dependencies: the entire supply chain of this adapter is this file plus
 * node's fetch. API: https://postmarkapp.com/developer/api/email-api
 */
import { optionalEnv, requireEnv } from "../../src/internal/config";
import { vendorHttpError, vendorNetworkError } from "../../src/internal/errors";
import type {
  AdapterSendInput,
  AdapterSendOutput,
  EmailAdapter,
  EmailAddress,
} from "../../src/internal/types";

const DEFAULT_BASE_URL = "https://api.postmarkapp.com";

function format(addr: EmailAddress): string {
  return addr.name !== undefined ? `${addr.name} <${addr.email}>` : addr.email;
}

async function sendViaPostmark(input: AdapterSendInput): Promise<AdapterSendOutput> {
  const token = requireEnv("POSTMARK_SERVER_TOKEN");
  // Base-URL override exists for the conformance fakes; never set it in production (SPEC.md).
  const baseUrl = optionalEnv("POSTMARK_BASE_URL") ?? DEFAULT_BASE_URL;
  const { from, message } = input;

  const body: Record<string, unknown> = {
    From: format(from),
    To: message.to.map(format).join(", "),
    Subject: message.subject,
    MessageStream: optionalEnv("POSTMARK_MESSAGE_STREAM") ?? "outbound",
  };
  if (message.html !== null) body["HtmlBody"] = message.html;
  if (message.text !== null) body["TextBody"] = message.text;
  if (message.replyTo !== null) body["ReplyTo"] = format(message.replyTo);
  const headerEntries = Object.entries(message.headers);
  if (headerEntries.length > 0) {
    body["Headers"] = headerEntries.map(([Name, Value]) => ({ Name, Value }));
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/email`, {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw vendorNetworkError("postmark", e);
  }

  // Error bodies are intentionally unread — raw vendor responses never escape (invariant 5).
  if (!res.ok) throw vendorHttpError("postmark", res.status);

  const data = (await res.json().catch(() => ({}))) as { MessageID?: unknown };
  return { id: typeof data.MessageID === "string" ? data.MessageID : "unknown" };
}

export const adapter: EmailAdapter = { name: "postmark", send: sendViaPostmark };
