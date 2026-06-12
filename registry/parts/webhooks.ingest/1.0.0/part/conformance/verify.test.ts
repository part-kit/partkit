/**
 * Conformance suite for capability webhooks.ingest@1.
 *
 * The SAME tests run against every adapter (docs/02 §4): the publish script
 * materializes each adapter into adapters/selected/ and runs this file once
 * per adapter. Each test names the contract invariant it makes true — the
 * invariant list in contract.json and this file must stay 1:1.
 *
 * Deliveries are signed by conformance/fake-sender.ts — independent
 * implementations of each vendor's signing algorithm — so adapter and suite
 * must agree at the wire format, not at our own code.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { adapter } from "../adapters/selected/adapter.js";
import {
  onWebhook,
  verifyWebhook,
  webhookHandler,
  WebhookError,
  type VerifiedWebhook,
} from "../src/index.js";
import { signStripe, signStandardWebhooks, type SignOptions } from "./fake-sender.js";

interface SchemeProfile {
  secret: string;
  /** A well-formed secret for the scheme that is NOT the configured one. */
  forgedSecret: string;
  sign: (opts: SignOptions) => Record<string, string>;
  /** The header carrying the signature — dropped/corrupted by negative tests. */
  signatureHeader: string;
  /** Flip one byte of the signature value, keeping the wire shape valid. */
  tamper: (value: string) => string;
}

const flipAt = (value: string, i: number): string =>
  value.slice(0, i) + (value[i] === "0" ? "1" : "0") + value.slice(i + 1);

const SCHEMES: Record<string, SchemeProfile> = {
  stripe: {
    secret: "whsec_partkit_test_secret_a1b2c3d4SECRET",
    forgedSecret: "whsec_partkit_test_secret_a1b2c3d4FORGED",
    sign: signStripe,
    signatureHeader: "stripe-signature",
    tamper: (v) => flipAt(v, v.length - 1),
  },
  standardwebhooks: {
    secret: `whsec_${Buffer.from("partkit-test-signing-key-SECRET!").toString("base64")}`,
    forgedSecret: `whsec_${Buffer.from("partkit-test-signing-key-FORGED!").toString("base64")}`,
    sign: signStandardWebhooks,
    signatureHeader: "webhook-signature",
    // flip inside the base64 body, past the "v1," prefix
    tamper: (v) => flipAt(v, 8),
  },
};

const profile = SCHEMES[adapter.name];
if (profile === undefined) {
  throw new Error(`No conformance profile for adapter "${adapter.name}" — add one to SCHEMES.`);
}
const scheme: SchemeProfile = profile;

beforeAll(() => {
  process.env["WEBHOOK_ADAPTER"] = adapter.name;
  process.env["WEBHOOK_SECRET"] = scheme.secret;
  delete process.env["WEBHOOK_TOLERANCE_SECONDS"];
});

/** Unique payload per call — keeps tests independent of the replay cache. */
let seq = 0;
function freshPayload(): string {
  seq += 1;
  return `{"event": "order.paid",  "seq": ${seq}, "adapter": "${adapter.name}"}`;
}

const now = (): number => Math.floor(Date.now() / 1000);

function signedRequest(payload: string, headers: Record<string, string>): Request {
  return new Request("https://app.test/api/webhooks/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  });
}

describe(`conformance: webhooks.ingest@1 · adapter: ${adapter.name}`, () => {
  it("happy path: a correctly signed delivery verifies and exposes id, timestamp, payload", async () => {
    const payload = freshPayload();
    const ts = now();
    const event = await verifyWebhook({
      payload,
      headers: scheme.sign({ payload, secret: scheme.secret, timestamp: ts }),
    });
    expect(event.payload).toBe(payload);
    expect(event.adapter).toBe(adapter.name);
    expect(event.id.length).toBeGreaterThan(0);
    expect(Math.abs(event.timestamp.getTime() / 1000 - ts)).toBeLessThanOrEqual(1);
  });

  it("happy path: key rotation — one valid signature among decoys verifies", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now(), decoy: true });
    const event = await verifyWebhook({ payload, headers });
    expect(event.payload).toBe(payload);
  });

  it("invariant 1: config is validated at call time with typed errors (no import-time I/O)", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    const saved = process.env["WEBHOOK_SECRET"];
    delete process.env["WEBHOOK_SECRET"];
    await expect(verifyWebhook({ payload, headers })).rejects.toMatchObject({
      name: "WebhookError",
      code: "config",
      status: 500,
    });
    process.env["WEBHOOK_SECRET"] = saved;
  });

  it("invariant 2a: missing signature headers are rejected with a typed error", async () => {
    const payload = freshPayload();
    await expect(verifyWebhook({ payload, headers: {} })).rejects.toMatchObject({
      name: "WebhookError",
      code: "missing_header",
      status: 400,
    });
  });

  it("invariant 2b: a tampered payload (any byte) fails verification", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    const tampered = payload.replace('"order.paid"', '"order.PAID"');
    await expect(verifyWebhook({ payload: tampered, headers })).rejects.toMatchObject({
      code: "invalid_signature",
      status: 400,
    });
  });

  it("invariant 2c: a tampered signature (any byte) fails verification", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    const sig = headers[scheme.signatureHeader];
    if (sig === undefined) throw new Error("profile bug: signature header missing");
    headers[scheme.signatureHeader] = scheme.tamper(sig);
    await expect(verifyWebhook({ payload, headers })).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("invariant 2d: a signature minted with the wrong secret fails verification", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({
      payload,
      secret: scheme.forgedSecret,
      timestamp: now(),
    });
    await expect(verifyWebhook({ payload, headers })).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("invariant 3a: a timestamp older than the tolerance window is rejected", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() - 360 });
    await expect(verifyWebhook({ payload, headers })).rejects.toMatchObject({
      code: "timestamp_out_of_window",
      status: 400,
    });
  });

  it("invariant 3b: a timestamp in the future beyond tolerance is rejected", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() + 360 });
    await expect(verifyWebhook({ payload, headers })).rejects.toMatchObject({
      code: "timestamp_out_of_window",
    });
  });

  it("invariant 3c: WEBHOOK_TOLERANCE_SECONDS narrows the window", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() - 30 });
    process.env["WEBHOOK_TOLERANCE_SECONDS"] = "10";
    try {
      await expect(verifyWebhook({ payload, headers })).rejects.toMatchObject({
        code: "timestamp_out_of_window",
      });
    } finally {
      delete process.env["WEBHOOK_TOLERANCE_SECONDS"];
    }
  });

  it("invariant 4: the identical delivery replayed within the window is rejected", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    await verifyWebhook({ payload, headers });
    await expect(verifyWebhook({ payload, headers })).rejects.toMatchObject({
      code: "replayed",
      status: 400,
    });
  });

  it("invariant 5: verification is over raw bytes — re-serialized JSON fails", async () => {
    const payload = freshPayload(); // contains a double space: re-serialization changes bytes
    const reserialized = JSON.stringify(JSON.parse(payload));
    expect(reserialized).not.toBe(payload);
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    await expect(verifyWebhook({ payload: reserialized, headers })).rejects.toMatchObject({
      code: "invalid_signature",
    });
    await expect(verifyWebhook({ payload, headers })).resolves.toMatchObject({ payload });
  });

  it("invariant 6: failures are typed WebhookError values; secrets never appear in messages", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    const sig = headers[scheme.signatureHeader];
    if (sig === undefined) throw new Error("profile bug: signature header missing");
    headers[scheme.signatureHeader] = scheme.tamper(sig);
    const err = await verifyWebhook({ payload, headers }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookError);
    expect((err as WebhookError).status).toBe(400);
    expect((err as WebhookError).message).not.toContain(scheme.secret);
  });

  it("invariant 7a: webhookHandler acks 200 only after every registered handler completed", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    let completed = false;
    const received: VerifiedWebhook[] = [];
    const unsubscribe = onWebhook(async (event) => {
      received.push(event);
      await new Promise((r) => setTimeout(r, 20));
      completed = true;
    });
    try {
      const res = await webhookHandler(signedRequest(payload, headers));
      expect(completed).toBe(true);
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.payload).toBe(payload);
    } finally {
      unsubscribe();
    }
  });

  it("invariant 7b: verification failures return 400 with a generic body; handlers never run", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    let ran = false;
    const unsubscribe = onWebhook(() => {
      ran = true;
    });
    try {
      const res = await webhookHandler(signedRequest(payload.replace("order", "ORDER"), headers));
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toBe('{"error":"webhook verification failed"}');
      expect(ran).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("invariant 7c: a throwing handler returns 500 so the vendor redelivers", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    const unsubscribe = onWebhook(() => {
      throw new Error("app handler exploded");
    });
    try {
      const res = await webhookHandler(signedRequest(payload, headers));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('{"error":"webhook handler failed"}');
    } finally {
      unsubscribe();
    }
  });

  it("invariant 7d: a mount with zero registered handlers returns 500, not a silent 200", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    const res = await webhookHandler(signedRequest(payload, headers));
    expect(res.status).toBe(500);
  });

  it("config: WEBHOOK_ADAPTER must match the vendored adapter (deploy-mismatch guard)", async () => {
    const payload = freshPayload();
    const headers = scheme.sign({ payload, secret: scheme.secret, timestamp: now() });
    process.env["WEBHOOK_ADAPTER"] = "some-other-adapter";
    try {
      await expect(verifyWebhook({ payload, headers })).rejects.toMatchObject({ code: "config" });
    } finally {
      process.env["WEBHOOK_ADAPTER"] = adapter.name;
    }
  });
});
