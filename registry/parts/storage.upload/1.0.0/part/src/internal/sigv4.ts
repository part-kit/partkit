import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 — query-string (presigned) variant for S3.
 * Implemented directly from the spec over node:crypto; zero npm dependencies.
 * Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 *
 * Conformance anchors every output of this module to AWS's own implementation
 * via known-answer vectors captured from the AWS CLI.
 */
const UNRESERVED = /[A-Za-z0-9\-_.~]/;

/**
 * RFC 3986 percent-encoding, UTF-8 aware. `encodeSlash=false` preserves "/"
 * for path segments (the S3 rule); `true` encodes it for query values. Each
 * non-unreserved byte becomes %XX of its UTF-8 bytes — so "Æ" → %C3%86.
 */
export function uriEncode(input: string, encodeSlash: boolean): string {
  let out = "";
  for (const byte of Buffer.from(input, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (UNRESERVED.test(ch)) out += ch;
    else if (ch === "/" && !encodeSlash) out += "/";
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), "s3"), "aws4_request"). */
function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

export interface CanonicalInput {
  method: string;
  /** Already-encoded canonical URI (path), e.g. "/bucket/a%20b.txt". */
  canonicalUri: string;
  /** Already-encoded, sorted canonical query string (no X-Amz-Signature). */
  canonicalQuery: string;
  host: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
  region: string;
  secretAccessKey: string;
}

/** Compute the hex SigV4 signature for a presigned S3 request (UNSIGNED-PAYLOAD). */
export function computeSignature(input: CanonicalInput): string {
  const dateStamp = input.amzDate.slice(0, 8);
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    `host:${input.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    `${dateStamp}/${input.region}/s3/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");
  return hmac(signingKey(input.secretAccessKey, dateStamp, input.region), stringToSign).toString(
    "hex",
  );
}

/** `Date` → "YYYYMMDDTHHMMSSZ" (UTC, second precision). */
export function formatAmzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
