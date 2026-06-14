/**
 * Amazon SES adapter — speaks the SES v2 SendEmail REST API directly, signed
 * with SigV4 by hand (../../src/internal/sigv4). ZERO npm dependencies: no
 * aws-sdk — the entire supply chain is this file, sigv4.ts, and node's fetch +
 * crypto. That is the point: the SES integration agents usually avoid (signing,
 * the v2 wire format) lives here, attested, so the app's choice is one line.
 * API: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
 */
import { optionalEnv, requireEnv } from "../../src/internal/config";
import { vendorHttpError, vendorNetworkError } from "../../src/internal/errors";
import { signV4 } from "../../src/internal/sigv4";
import type {
  AdapterSendInput,
  AdapterSendOutput,
  EmailAdapter,
  EmailAddress,
} from "../../src/internal/types";

const SES_PATH = "/v2/email/outbound-emails";

function format(addr: EmailAddress): string {
  return addr.name !== undefined ? `${addr.name} <${addr.email}>` : addr.email;
}

async function sendViaSes(input: AdapterSendInput): Promise<AdapterSendOutput> {
  const accessKeyId = requireEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY");
  const region = requireEnv("AWS_REGION");
  // Base-URL override exists for the conformance fakes; never set it in production (SPEC.md).
  const baseUrl = optionalEnv("SES_BASE_URL") ?? `https://email.${region}.amazonaws.com`;
  const { from, message } = input;

  const bodyContent: Record<string, unknown> = {};
  if (message.html !== null) bodyContent["Html"] = { Data: message.html, Charset: "UTF-8" };
  if (message.text !== null) bodyContent["Text"] = { Data: message.text, Charset: "UTF-8" };

  const simple: Record<string, unknown> = {
    Subject: { Data: message.subject, Charset: "UTF-8" },
    Body: bodyContent,
  };
  if (Object.keys(message.headers).length > 0) {
    simple["Headers"] = Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value }));
  }

  const payload: Record<string, unknown> = {
    FromEmailAddress: format(from),
    Destination: { ToAddresses: message.to.map(format) },
    Content: { Simple: simple },
  };
  if (message.replyTo !== null) payload["ReplyToAddresses"] = [format(message.replyTo)];

  const bodyStr = JSON.stringify(payload);
  const url = `${baseUrl}${SES_PATH}`;
  const host = new URL(url).host;
  const contentType = "application/json";
  const signed = signV4({
    method: "POST",
    host,
    path: SES_PATH,
    body: bodyStr,
    service: "ses",
    region,
    accessKeyId,
    secretAccessKey,
    contentType,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "X-Amz-Date": signed.amzDate,
        Authorization: signed.authorization,
      },
      body: bodyStr,
    });
  } catch (e) {
    throw vendorNetworkError("ses", e);
  }

  // Error bodies are intentionally unread — raw vendor responses never escape (invariant 5).
  if (!res.ok) throw vendorHttpError("ses", res.status);

  const data = (await res.json().catch(() => ({}))) as { MessageId?: unknown };
  return { id: typeof data.MessageId === "string" ? data.MessageId : "unknown" };
}

export const adapter: EmailAdapter = { name: "ses", send: sendViaSes };
