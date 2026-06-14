/**
 * Conformance suite for capability email.transactional@1.
 *
 * The SAME tests run against every adapter (docs/02 §4): the publish script
 * materializes each adapter into adapters/selected/ and runs this file once
 * per adapter. Each test names the contract invariant it makes true — the
 * invariant list in contract.json and this file must stay 1:1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adapter } from "../adapters/selected/adapter";
import { EmailError, send, type EmailMessage } from "../src/index";
import { signingKey } from "../src/internal/sigv4";
import { FakeVendor } from "./fake-vendor";

const API_KEY = "partkit-test-key-a1b2c3d4-SECRET";

interface VendorProfile {
  keyEnv: string;
  baseUrlEnv: string;
  successBody: () => unknown;
  expectAuth: (headers: Record<string, string | string[] | undefined>) => void;
  /** Extra env an adapter needs beyond keyEnv (e.g. SES's secret + region). */
  extraEnv?: Record<string, string>;
}

const VENDORS: Record<string, VendorProfile> = {
  resend: {
    keyEnv: "RESEND_API_KEY",
    baseUrlEnv: "RESEND_BASE_URL",
    successBody: () => ({ id: "re_fake_123" }),
    expectAuth: (h) => expect(h["authorization"]).toBe(`Bearer ${API_KEY}`),
  },
  postmark: {
    keyEnv: "POSTMARK_SERVER_TOKEN",
    baseUrlEnv: "POSTMARK_BASE_URL",
    successBody: () => ({ MessageID: "pm-fake-123" }),
    expectAuth: (h) => expect(h["x-postmark-server-token"]).toBe(API_KEY),
  },
  ses: {
    keyEnv: "AWS_ACCESS_KEY_ID",
    baseUrlEnv: "SES_BASE_URL",
    extraEnv: { AWS_SECRET_ACCESS_KEY: "test-secret-access-key-aws", AWS_REGION: "us-east-1" },
    successBody: () => ({ MessageId: "ses-fake-0102" }),
    expectAuth: (h) => {
      const auth = String(h["authorization"] ?? "");
      expect(auth).toContain("AWS4-HMAC-SHA256");
      expect(auth).toContain(`Credential=${API_KEY}/`);
      expect(auth).toContain("/us-east-1/ses/aws4_request");
      expect(auth).toContain("SignedHeaders=content-type;host;x-amz-date");
      expect(auth).toMatch(/Signature=[0-9a-f]{64}/);
    },
  },
};

const profile = VENDORS[adapter.name];
if (profile === undefined) {
  throw new Error(`No conformance profile for adapter "${adapter.name}" — add one to VENDORS.`);
}
const vendor: VendorProfile = profile;
const fake = new FakeVendor(vendor.successBody);

beforeAll(async () => {
  const baseUrl = await fake.start();
  process.env[vendor.baseUrlEnv] = baseUrl;
  process.env[vendor.keyEnv] = API_KEY;
  for (const [k, v] of Object.entries(vendor.extraEnv ?? {})) process.env[k] = v;
  process.env["EMAIL_ADAPTER"] = adapter.name;
  process.env["EMAIL_FROM"] = "Acme <hello@acme.test>";
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
});

const MESSAGE: EmailMessage = {
  to: { email: "user@example.test", name: "User" },
  subject: "Welcome to Acme",
  html: "<p>hi</p>",
  text: "hi",
};

describe(`conformance: email.transactional@1 · adapter: ${adapter.name}`, () => {
  it("happy path: returns the vendor id, authenticates correctly, sends the payload", async () => {
    const res = await send(MESSAGE);
    expect(res.id.length).toBeGreaterThan(0);
    expect(res.adapter).toBe(adapter.name);
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.method).toBe("POST");
    vendor.expectAuth(req.headers);
    expect(JSON.stringify(req.body)).toContain("Welcome to Acme");
    expect(JSON.stringify(req.body)).toContain("user@example.test");
  });

  it("invariant 2: an invalid message fails fast with zero network calls", async () => {
    const noBody = { to: MESSAGE.to, subject: MESSAGE.subject };
    await expect(send(noBody as EmailMessage)).rejects.toMatchObject({
      name: "EmailError",
      code: "invalid_message",
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("invariant 3: CR/LF in subject, display names, or headers is rejected (header injection)", async () => {
    await expect(
      send({ ...MESSAGE, subject: "hi\r\nBcc: attacker@evil.test" }),
    ).rejects.toMatchObject({ code: "invalid_message" });
    await expect(
      send({ ...MESSAGE, to: { email: "user@example.test", name: "Eve\r\nBcc: x" } }),
    ).rejects.toMatchObject({ code: "invalid_message" });
    await expect(
      send({ ...MESSAGE, headers: { "X-Note": "a\r\nBcc: attacker@evil.test" } }),
    ).rejects.toMatchObject({ code: "invalid_message" });
    expect(fake.requests).toHaveLength(0);
  });

  it("invariant 4a: a transient 429 is retried and then succeeds", async () => {
    fake.scriptNext({ status: 429 });
    const res = await send(MESSAGE);
    expect(res.id.length).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(2);
  });

  it("invariant 4b: persistent 5xx exhausts exactly 3 attempts and surfaces typed", async () => {
    fake.scriptNext({ status: 500 }, { status: 502 }, { status: 503 });
    await expect(send(MESSAGE)).rejects.toMatchObject({
      code: "vendor_unavailable",
      retryable: true,
    });
    expect(fake.requests).toHaveLength(3);
  });

  it("invariant 4c: auth failures are NEVER retried", async () => {
    fake.scriptNext({ status: 401 });
    await expect(send(MESSAGE)).rejects.toMatchObject({ code: "auth", retryable: false });
    expect(fake.requests).toHaveLength(1);
  });

  it("invariant 5: failures are typed EmailError values; raw vendor bodies never escape", async () => {
    fake.scriptNext(
      { status: 500, body: { internal: "vendor-stacktrace-with-internals" } },
      { status: 500, body: { internal: "vendor-stacktrace-with-internals" } },
      { status: 500, body: { internal: "vendor-stacktrace-with-internals" } },
    );
    const err = await send(MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect((err as EmailError).message).not.toContain("vendor-stacktrace-with-internals");
  });

  it("invariant 6: secret values never appear in error messages", async () => {
    fake.scriptNext({ status: 401 });
    const err = await send(MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect((err as EmailError).message).not.toContain(API_KEY);
  });

  it("invariant 1: config is validated at call time with typed errors (no import-time I/O)", async () => {
    const saved = process.env["EMAIL_FROM"];
    delete process.env["EMAIL_FROM"];
    await expect(send(MESSAGE)).rejects.toMatchObject({ code: "config" });
    if (saved !== undefined) process.env["EMAIL_FROM"] = saved;
    expect(fake.requests).toHaveLength(0);
  });

  it("config: EMAIL_ADAPTER must match the vendored adapter (deploy-mismatch guard)", async () => {
    process.env["EMAIL_ADAPTER"] = "some-other-adapter";
    await expect(send(MESSAGE)).rejects.toMatchObject({ code: "config" });
    process.env["EMAIL_ADAPTER"] = adapter.name;
    expect(fake.requests).toHaveLength(0);
  });
});

/**
 * The SES adapter's SigV4 signing is only as trustworthy as the HMAC chain that
 * produces it. Anchor it to AWS's OWN documented signing-key derivation example
 * — if our chain drifts by a byte, this fails. (The fake vendor records the
 * request but does not verify the signature, so without this anchor a wrong
 * SigV4 would still pass the wire tests.) The module ships in the part for the
 * ses adapter, so this runs in every adapter materialization.
 * Vector: AWS "Examples of how to derive a signing key for Signature Version 4".
 */
describe("SigV4 signing key · AWS documented known-answer vector", () => {
  it("derives AWS's documented signing key byte-for-byte", () => {
    const key = signingKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20150830",
      "us-east-1",
      "iam",
    );
    expect(key.toString("hex")).toBe(
      "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
    );
  });
});
