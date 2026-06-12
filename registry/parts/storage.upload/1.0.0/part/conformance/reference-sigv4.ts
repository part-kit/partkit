/**
 * An INDEPENDENT reimplementation of S3 SigV4 query presigning, written from
 * the AWS spec — the analog of the webhooks part's independent fake-sender.
 * It is FIRST validated against AWS's own output (the botocore vectors in the
 * suite), then used as the oracle for the PUT/upload path, which the AWS CLI
 * cannot presign. If the part and this file agree AND this file matches
 * botocore, the part matches AWS.
 *
 * Deliberately structured differently from the part (computes everything from
 * high-level inputs in one function) so a shared bug is unlikely.
 */
import { createHash, createHmac } from "node:crypto";

export interface ReferenceInput {
  method: "GET" | "PUT";
  endpoint: string; // e.g. https://s3.example.com or https://minio.local:9000
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  amzDate: string; // YYYYMMDDTHHMMSSZ
  expiresInSeconds: number;
}

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

function encode(input: string, encodeSlash: boolean): string {
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

export function presignReference(input: ReferenceInput): { signature: string; url: string } {
  const url = new URL(input.endpoint);
  const scheme = url.protocol.replace(":", "");
  const defaultPort = scheme === "https" ? "443" : "80";
  const portPart = url.port && url.port !== defaultPort ? `:${url.port}` : "";

  const host = input.forcePathStyle
    ? `${url.hostname}${portPart}`
    : `${input.bucket}.${url.hostname}${portPart}`;
  const canonicalUri = input.forcePathStyle
    ? `/${encode(input.bucket, true)}/${encode(input.key, false)}`
    : `/${encode(input.key, false)}`;

  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const credential = `${input.accessKeyId}/${scope}`;

  const query: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", input.amzDate],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query
    .map(([k, v]) => `${encode(k, true)}=${encode(v, true)}`)
    .join("&");

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const url2 = `${scheme}://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return { signature, url: url2 };
}
