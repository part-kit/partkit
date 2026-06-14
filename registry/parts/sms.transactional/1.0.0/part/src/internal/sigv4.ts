import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 — header-authorization variant for a JSON POST
 * (used by the SES adapter). Implemented directly from the spec over
 * node:crypto; zero npm dependencies, no aws-sdk.
 * Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 *
 * The signing-key derivation is anchored to AWS's own documented test vector by
 * conformance (signingKey export below), so the HMAC chain is byte-correct.
 */

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request"). */
export function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** `Date` → "YYYYMMDDTHHMMSSZ" (UTC, second precision). */
export function formatAmzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export interface SignInput {
  method: string;
  host: string;
  /** Already-canonical path, e.g. "/v2/email/outbound-emails". */
  path: string;
  body: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  contentType: string;
  now?: Date;
}

export interface SignedHeaders {
  authorization: string;
  amzDate: string;
}

/**
 * Sign a request and return the `Authorization` header value + the `x-amz-date`
 * used (the caller must send both, plus host + content-type, unchanged). Signs
 * exactly `content-type;host;x-amz-date`; the payload hash is the last line of
 * the canonical request (no x-amz-content-sha256 — that is S3-only).
 */
export function signV4(input: SignInput): SignedHeaders {
  const amzDate = formatAmzDate(input.now ?? new Date());
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  const canonicalHeaders =
    `content-type:${input.contentType}\n` + `host:${input.host}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = [
    input.method,
    input.path,
    "", // empty canonical query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(
    signingKey(input.secretAccessKey, dateStamp, input.region, input.service),
    stringToSign,
  ).toString("hex");

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
  };
}
