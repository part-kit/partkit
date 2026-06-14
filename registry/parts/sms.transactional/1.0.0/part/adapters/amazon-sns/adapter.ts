/**
 * Amazon SNS adapter — SNS `Publish` (SMS) over the query protocol, signed with
 * SigV4 by hand (../../src/internal/sigv4, service=sns — the SAME signer the SES
 * email adapter proved, anchored to AWS's documented known-answer vector). ZERO
 * npm dependencies: no aws-sdk. The "fiddly / cheaper" vendor; the flip from
 * twilio is one command. API: https://docs.aws.amazon.com/sns/latest/api/API_Publish.html
 */
import { optionalEnv, requireEnv } from "../../src/internal/config";
import { vendorHttpError, vendorNetworkError } from "../../src/internal/errors";
import { signV4 } from "../../src/internal/sigv4";
import type { AdapterSendOutput, NormalizedSms, SmsAdapter } from "../../src/internal/types";

/** Pull <MessageId> out of the SNS query-protocol XML response (no XML dep). */
function messageId(xml: string): string {
  const open = "<MessageId>";
  const close = "</MessageId>";
  const i = xml.indexOf(open);
  if (i === -1) return "unknown";
  const j = xml.indexOf(close, i + open.length);
  return j > i ? xml.slice(i + open.length, j) : "unknown";
}

async function sendViaSns(message: NormalizedSms): Promise<AdapterSendOutput> {
  const accessKeyId = requireEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY");
  const region = requireEnv("AWS_REGION");
  // Base-URL override exists for the conformance fakes; never set it in production (SPEC.md).
  const baseUrl = optionalEnv("SNS_BASE_URL") ?? `https://sns.${region}.amazonaws.com`;

  // SNS query protocol: params in a form body; the SigV4 payload hash covers them.
  const body = new URLSearchParams({
    Action: "Publish",
    Version: "2010-03-31",
    PhoneNumber: message.to,
    Message: message.body,
  }).toString();

  const host = new URL(baseUrl).host;
  const contentType = "application/x-www-form-urlencoded; charset=utf-8";
  const signed = signV4({
    method: "POST",
    host,
    path: "/",
    body,
    service: "sns",
    region,
    accessKeyId,
    secretAccessKey,
    contentType,
  });

  let res: Response;
  try {
    res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "X-Amz-Date": signed.amzDate,
        Authorization: signed.authorization,
      },
      body,
    });
  } catch (e) {
    throw vendorNetworkError("amazon-sns", e);
  }

  // Error bodies are intentionally unread — raw vendor responses never escape (invariant 5).
  if (!res.ok) throw vendorHttpError("amazon-sns", res.status);

  const xml = await res.text().catch(() => "");
  return { id: messageId(xml) };
}

export const adapter: SmsAdapter = { name: "amazon-sns", send: sendViaSns };
