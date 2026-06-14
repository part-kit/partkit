/**
 * Conformance suite for capability sms.transactional@1.
 *
 * The SAME tests run against every adapter (docs/02 §4): the publish script
 * materializes each adapter into adapters/selected/ and runs this file once per
 * adapter, branching on adapter.name via VENDORS. Each test names the contract
 * invariant it makes true — the invariant list in contract.json and this file
 * stay 1:1. Both adapters are zero-dependency, so the suite needs no extra
 * packages; it drives a protocol-faithful fake HTTP server.
 */
import { Buffer } from "node:buffer";
import process from "node:process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adapter } from "../adapters/selected/adapter";
import { send, SmsError, type SmsMessage } from "../src/index";
import { signingKey, signV4 } from "../src/internal/sigv4";
import { FakeVendor, type RecordedRequest, type ScriptedResponse } from "./fake-vendor";

const TWILIO_SID = "AC_test_account_sid_0001";
const TWILIO_TOKEN = "twilio-auth-token-SECRET-abcdef";
const AWS_KEY = "AKIA_test_access_key_0001";
const AWS_SECRET = "aws-secret-access-key-SECRET-abcdef";

const MESSAGE: SmsMessage = { to: "+15551230000", body: "Your code is 123456", from: "+15559990000" };

type Headers = Record<string, string | string[] | undefined>;

/** "YYYYMMDDTHHMMSSZ" → Date (the inverse of sigv4.formatAmzDate, second precision). */
function parseAmz(d: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(d);
  if (m === null) return new Date(0);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

interface VendorProfile {
  setup(baseUrl: string): void;
  teardown(): void;
  success(): ScriptedResponse;
  /** The vendor message id the success response carries (must round-trip exactly). */
  expectedId: string;
  /** Assert the adapter authenticated correctly, given the full recorded request. */
  expectAuth(req: RecordedRequest): void;
  /** Assert the wire payload carries the message and nothing extra. */
  expectPayload(body: Record<string, string>): void;
  /** The secret env value (must never appear in an error). */
  secret(): string;
  /** A required credential env to delete for the config test. */
  credentialEnv: string;
}

const VENDORS: Record<string, VendorProfile> = {
  twilio: {
    setup: (baseUrl) => {
      process.env["TWILIO_BASE_URL"] = baseUrl;
      process.env["TWILIO_ACCOUNT_SID"] = TWILIO_SID;
      process.env["TWILIO_AUTH_TOKEN"] = TWILIO_TOKEN;
    },
    teardown: () => {
      delete process.env["TWILIO_BASE_URL"];
      delete process.env["TWILIO_ACCOUNT_SID"];
      delete process.env["TWILIO_AUTH_TOKEN"];
      delete process.env["TWILIO_FROM"];
    },
    success: () => ({ status: 200, body: JSON.stringify({ sid: "SM_fake_0102" }), contentType: "application/json" }),
    expectedId: "SM_fake_0102",
    expectAuth: (req) => {
      const expected = `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64")}`;
      expect(req.headers["authorization"]).toBe(expected);
    },
    expectPayload: (b) => {
      expect(b["To"]).toBe(MESSAGE.to);
      expect(b["Body"]).toBe(MESSAGE.body);
      expect(b["From"]).toBe(MESSAGE.from); // a number → From, never MessagingServiceSid
      expect(b["MessagingServiceSid"]).toBeUndefined();
    },
    secret: () => TWILIO_TOKEN,
    credentialEnv: "TWILIO_AUTH_TOKEN",
  },
  "amazon-sns": {
    setup: (baseUrl) => {
      process.env["SNS_BASE_URL"] = baseUrl;
      process.env["AWS_ACCESS_KEY_ID"] = AWS_KEY;
      process.env["AWS_SECRET_ACCESS_KEY"] = AWS_SECRET;
      process.env["AWS_REGION"] = "us-east-1";
    },
    teardown: () => {
      delete process.env["SNS_BASE_URL"];
      delete process.env["AWS_ACCESS_KEY_ID"];
      delete process.env["AWS_SECRET_ACCESS_KEY"];
      delete process.env["AWS_REGION"];
    },
    success: () => ({
      status: 200,
      contentType: "text/xml",
      body: "<PublishResponse><PublishResult><MessageId>sns-fake-0102</MessageId></PublishResult></PublishResponse>",
    }),
    expectedId: "sns-fake-0102",
    expectAuth: (req) => {
      const auth = String(req.headers["authorization"] ?? "");
      expect(auth).toContain("AWS4-HMAC-SHA256");
      expect(auth).toContain(`Credential=${AWS_KEY}/`);
      expect(auth).toContain("/us-east-1/sns/aws4_request");
      expect(auth).toContain("SignedHeaders=content-type;host;x-amz-date");
      expect(auth).toMatch(/Signature=[0-9a-f]{64}/);
      // Recompute the signature from the RECORDED request: proves the bytes the
      // adapter SIGNED are exactly the bytes it SENT (path, body, content-type,
      // host, date all consistent) — a real canonical-request correctness check,
      // not just a structural header match.
      const amzDate = String(req.headers["x-amz-date"] ?? "");
      const host = String(req.headers["host"] ?? "");
      const recomputed = signV4({
        method: "POST",
        host,
        path: "/",
        body: req.raw,
        service: "sns",
        region: "us-east-1",
        accessKeyId: AWS_KEY,
        secretAccessKey: AWS_SECRET,
        contentType: "application/x-www-form-urlencoded; charset=utf-8",
        now: parseAmz(amzDate),
      });
      expect(auth).toBe(recomputed.authorization);
    },
    expectPayload: (b) => {
      expect(b["Action"]).toBe("Publish");
      expect(b["Version"]).toBe("2010-03-31");
      expect(b["PhoneNumber"]).toBe(MESSAGE.to);
      expect(b["Message"]).toBe(MESSAGE.body);
      // exactly these four params — no surprise fields signed/sent
      expect(Object.keys(b).sort()).toEqual(["Action", "Message", "PhoneNumber", "Version"]);
    },
    secret: () => AWS_SECRET,
    credentialEnv: "AWS_REGION",
  },
};

const profile = VENDORS[adapter.name];
if (profile === undefined) {
  throw new Error(`No conformance profile for adapter "${adapter.name}" — add one to VENDORS.`);
}
const vendor: VendorProfile = profile;
const fake = new FakeVendor(() => vendor.success());

beforeAll(async () => {
  const baseUrl = await fake.start();
  vendor.setup(baseUrl);
  process.env["SMS_ADAPTER"] = adapter.name;
});
afterAll(async () => {
  await fake.stop();
  vendor.teardown();
  delete process.env["SMS_ADAPTER"];
});
beforeEach(() => {
  fake.reset();
});

describe(`conformance: sms.transactional@1 · adapter: ${adapter.name}`, () => {
  it("happy path: returns the vendor id, authenticates correctly, sends the payload", async () => {
    const res = await send(MESSAGE);
    expect(res.id).toBe(vendor.expectedId); // the actual vendor id round-trips (not the 'unknown' fallback)
    expect(res.adapter).toBe(adapter.name);
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0] as RecordedRequest;
    expect(req.method).toBe("POST");
    vendor.expectAuth(req);
    vendor.expectPayload(req.body);
  });

  it("invariant 2: an invalid recipient or empty body fails fast with zero network calls", async () => {
    await expect(send({ to: "not-e164", body: "hi" })).rejects.toMatchObject({
      name: "SmsError",
      code: "invalid_message",
    });
    await expect(send({ to: "+15551230000", body: "" })).rejects.toMatchObject({ code: "invalid_message" });
    expect(fake.requests).toHaveLength(0);
  });

  it("invariant 3: disallowed control characters in the body or sender are rejected (zero network calls)", async () => {
    const nul = String.fromCharCode(0);
    await expect(send({ to: "+15551230000", body: `hi${nul}there` })).rejects.toMatchObject({
      code: "invalid_message",
    });
    const bell = String.fromCharCode(7);
    await expect(send({ to: "+15551230000", body: "ok", from: `x${bell}y` })).rejects.toMatchObject({
      code: "invalid_message",
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("invariant 4a: a transient 429 is retried and then succeeds", async () => {
    fake.scriptNext({ status: 429 });
    const res = await send(MESSAGE);
    expect(res.id).toBe(vendor.expectedId);
    expect(fake.requests).toHaveLength(2);
  });

  it("invariant 4a: a transient NETWORK failure is retried and then succeeds", async () => {
    fake.scriptNext({ status: 0, networkError: true });
    const res = await send(MESSAGE);
    expect(res.id).toBe(vendor.expectedId);
    expect(fake.requests).toHaveLength(2);
  });

  it("invariant 4b: persistent 5xx exhausts exactly 3 attempts and surfaces typed", async () => {
    fake.scriptNext({ status: 500 }, { status: 502 }, { status: 503 });
    await expect(send(MESSAGE)).rejects.toMatchObject({ code: "vendor_unavailable", retryable: true });
    expect(fake.requests).toHaveLength(3);
  });

  it("invariant 4c: auth failures are NEVER retried", async () => {
    fake.scriptNext({ status: 401 });
    await expect(send(MESSAGE)).rejects.toMatchObject({ code: "auth", retryable: false });
    expect(fake.requests).toHaveLength(1);
  });

  it("invariant 5: failures are typed SmsError values; raw vendor bodies never escape", async () => {
    const leak = { status: 500, body: "vendor-stacktrace-with-internals", contentType: "text/plain" };
    fake.scriptNext(leak, leak, leak);
    const err = await send(MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsError);
    expect((err as SmsError).message).not.toContain("vendor-stacktrace-with-internals");
  });

  it("invariant 6: secret values never appear in error messages", async () => {
    fake.scriptNext({ status: 401 });
    const err = await send(MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsError);
    expect((err as SmsError).message).not.toContain(vendor.secret());
  });

  it("invariant 1: config is validated at call time with typed errors (no import-time I/O)", async () => {
    const saved = process.env[vendor.credentialEnv];
    delete process.env[vendor.credentialEnv];
    await expect(send(MESSAGE)).rejects.toMatchObject({ code: "config" });
    if (saved !== undefined) process.env[vendor.credentialEnv] = saved;
    expect(fake.requests).toHaveLength(0);
  });

  it("config: SMS_ADAPTER must match the vendored adapter (deploy-mismatch guard)", async () => {
    process.env["SMS_ADAPTER"] = "some-other-adapter";
    await expect(send(MESSAGE)).rejects.toMatchObject({ code: "config" });
    process.env["SMS_ADAPTER"] = adapter.name;
    expect(fake.requests).toHaveLength(0);
  });
});

// Twilio-specific sender routing — the From vs MessagingServiceSid branch and the
// TWILIO_FROM fallback (both untested by the shared MESSAGE, which carries a number).
describe.skipIf(adapter.name !== "twilio")("sms.transactional@1 · twilio sender routing", () => {
  it("a Messaging Service SID (MG…) routes to MessagingServiceSid, not From", async () => {
    await send({ to: MESSAGE.to, body: MESSAGE.body, from: "MG0123456789abcdef0123456789abcdef" });
    const b = (fake.requests[0] as RecordedRequest).body;
    expect(b["MessagingServiceSid"]).toBe("MG0123456789abcdef0123456789abcdef");
    expect(b["From"]).toBeUndefined();
  });

  it("falls back to TWILIO_FROM when message.from is omitted", async () => {
    process.env["TWILIO_FROM"] = "+15550001111";
    try {
      await send({ to: MESSAGE.to, body: MESSAGE.body });
      const b = (fake.requests[0] as RecordedRequest).body;
      expect(b["From"]).toBe("+15550001111");
    } finally {
      delete process.env["TWILIO_FROM"];
    }
  });

  it("no sender at all (no from, no TWILIO_FROM) fails fast as config, zero network calls", async () => {
    await expect(send({ to: MESSAGE.to, body: MESSAGE.body })).rejects.toMatchObject({ code: "config" });
    expect(fake.requests).toHaveLength(0);
  });
});

/**
 * The amazon-sns adapter's SigV4 signing is only as trustworthy as the HMAC chain
 * that produces it. Anchor it to AWS's OWN documented signing-key derivation
 * example — if our chain drifts by a byte, this fails. sigv4.ts ships in the part
 * for the amazon-sns adapter, so this runs in every adapter materialization.
 * Vector: AWS "Examples of how to derive a signing key for Signature Version 4".
 */
describe("SigV4 signing key · AWS documented known-answer vector", () => {
  it("derives AWS's documented signing key byte-for-byte", () => {
    const key = signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam");
    expect(key.toString("hex")).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
  });
});
