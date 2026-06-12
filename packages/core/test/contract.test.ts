import { describe, expect, it } from "vitest";
import { ContractSchema, capabilityOf, effectiveNpmDependencies } from "@part-kit/core";

/** The exact example from docs/02-part-specification.md §2 — schema and spec must not drift apart. */
const DOCS_EXAMPLE = {
  part: "billing.subscription",
  version: "1.3.0",
  contract_version: "0.2",
  provides: ["billing.subscription@1"],
  requires: ["auth.session>=1", "email.transactional>=1"],
  platform: { node: ">=22", next: ">=15 <17", postgres: ">=16" },
  adapters: [
    {
      name: "stripe",
      vendor_api: "2026-04",
      status: "attested",
      npm_dependencies: { stripe: "^17.0.0" },
    },
    { name: "paddle", vendor_api: "v2", status: "attested" },
    { name: "lemonsqueezy", vendor_api: "v1", status: "community" },
  ],
  interface: {
    exports: [
      "createCheckout(planId, userId): CheckoutSession",
      "getSubscription(userId): Subscription | null",
      "cancelAtPeriodEnd(subscriptionId): void",
      "onSubscriptionChange(handler): Unsubscribe",
    ],
    events: [
      "subscription.created",
      "subscription.updated",
      "subscription.canceled",
      "payment.failed",
    ],
    http_routes: [{ route: "POST /api/webhooks/billing", export: "billingWebhookHandler" }],
  },
  env: {
    BILLING_SECRET_KEY: { required: true, secret: true },
    BILLING_WEBHOOK_SECRET: { required: true, secret: true },
    BILLING_ADAPTER: { required: true, enum: ["stripe", "paddle", "lemonsqueezy"] },
  },
  data_ownership: {
    tables: ["billing_subscriptions", "billing_events"],
    writes_only_own_tables: true,
  },
  invariants: [
    "Webhook handling is idempotent under at-least-once delivery",
    "No card data is ever stored or logged in the application",
    "Subscription state derives solely from verified webhook events, never from client input",
    "All adapter calls are retried with exponential backoff and surfaced as typed errors",
  ],
  threat_model: "SPEC.md#threat-model",
  license: "MIT",
  attestation: "ATTESTATION.json",
};

describe("ContractSchema", () => {
  it("validates the canonical example from docs/02 §2", () => {
    const parsed = ContractSchema.parse(DOCS_EXAMPLE);
    expect(parsed.part).toBe("billing.subscription");
    expect(parsed.provides).toEqual(["billing.subscription@1"]);
  });

  it("rejects the retired slo field shape via strict invariants — slo is not a known key but extra keys are tolerated; what matters is requires/provides grammar", () => {
    // requires must reference capability majors, never concrete parts
    expect(() =>
      ContractSchema.parse({ ...DOCS_EXAMPLE, requires: ["some-part-1.2.3"] }),
    ).toThrow();
    // provides must pin a capability major
    expect(() =>
      ContractSchema.parse({ ...DOCS_EXAMPLE, provides: ["billing.subscription"] }),
    ).toThrow();
  });

  it("capabilityOf strips the version pin", () => {
    expect(capabilityOf("billing.subscription@1")).toBe("billing.subscription");
    expect(capabilityOf("auth.session")).toBe("auth.session");
  });

  it("npm_dependencies requires contract_version 0.2 and valid semver ranges (RFC 0001)", () => {
    // The docs example carries adapter-level deps — 0.1 must fail closed.
    expect(() =>
      ContractSchema.parse({ ...DOCS_EXAMPLE, contract_version: "0.1" }),
    ).toThrow(/contract_version 0.2/);
    expect(() =>
      ContractSchema.parse({
        ...DOCS_EXAMPLE,
        npm_dependencies: { "better-auth": "not a range" },
      }),
    ).toThrow(/semver range/);
  });

  it("effectiveNpmDependencies merges part-wide with the selected adapter only", () => {
    const c = ContractSchema.parse({
      ...DOCS_EXAMPLE,
      npm_dependencies: { "better-auth": "^1.3.0" },
    });
    expect(effectiveNpmDependencies(c, "stripe")).toEqual({
      "better-auth": "^1.3.0",
      stripe: "^17.0.0",
    });
    expect(effectiveNpmDependencies(c, "paddle")).toEqual({ "better-auth": "^1.3.0" });
    expect(effectiveNpmDependencies(c, null)).toEqual({ "better-auth": "^1.3.0" });
  });
});
