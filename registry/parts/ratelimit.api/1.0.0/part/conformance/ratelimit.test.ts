/**
 * Conformance suite for capability ratelimit.api@1.
 *
 * Each test names the contract invariant it makes true — the invariant list in
 * contract.json and this file must stay 1:1. This part ships no registry
 * adapters (the store is an app seam, not a vendored adapter), so the publish
 * script runs this suite once. Store-agnosticism (invariants 1–6) is instead
 * proven INSIDE the run: `describe.each` executes the whole block against the
 * built-in store (no store passed) and the independent ReferenceStore.
 *
 * Time is controlled with fake timers so fixed-window rollover is deterministic
 * without sleeping real seconds.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rateLimit,
  rateLimitHeaders,
  rateLimitMiddleware,
  RateLimitError,
  tooManyRequests,
  type RateLimitOpts,
  type RateLimitRule,
  type RateLimitStore,
} from "../src/index.js";
import { FailingStore, ReferenceStore } from "./reference-store.js";

/** A clean window boundary: a multiple of 60_000 ms, so windowStart math is exact. */
const BASE = 1_736_000_040_000;
const RULE: RateLimitRule = { limit: 3, windowSeconds: 60 };

let seq = 0;
/** Unique key per call — the built-in store is a per-instance singleton that
 * persists across tests; fresh keys keep every test independent. */
function freshKey(): string {
  seq += 1;
  return `conformance-key-${seq}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterAll(() => {
  vi.useRealTimers();
});

interface StoreCase {
  label: string;
  /** undefined → use the part's built-in singleton store. */
  makeStore: () => RateLimitStore | undefined;
}

const STORE_CASES: StoreCase[] = [
  { label: "built-in memory store", makeStore: () => undefined },
  { label: "independent ReferenceStore", makeStore: () => new ReferenceStore() },
];

describe.each(STORE_CASES)(
  "conformance: ratelimit.api@1 · store: $label",
  ({ makeStore }) => {
    // One store instance per test — minted fresh in beforeEach so counts
    // accumulate within a test but never leak across tests.
    let store: RateLimitStore | undefined;
    beforeEach(() => {
      store = makeStore();
    });
    const opts = (): RateLimitOpts => (store !== undefined ? { store } : {});

    it("invariant 1: importing performs no I/O; an invalid config is a typed error", async () => {
      // Import already happened at top of file with no env, no I/O, no throw.
      // A non-function identify is a config error caught at call time.
      const mw = rateLimitMiddleware({
        rule: RULE,
        // @ts-expect-error — deliberately wrong type to prove call-time validation
        identify: "not-a-function",
        ...opts(),
      });
      const req = new Request("https://app.test/api", { headers: { "x-forwarded-for": "1.1.1.1" } });
      await expect(mw(req)).rejects.toMatchObject({
        name: "RateLimitError",
        code: "invalid_config",
      });
    });

    it("invariant 2: first `limit` requests pass, the next is rejected (fixed window)", async () => {
      const key = freshKey();
      const seen: boolean[] = [];
      for (let i = 0; i < RULE.limit + 1; i += 1) {
        const r = await rateLimit(key, RULE, opts());
        seen.push(r.ok);
      }
      expect(seen).toEqual([true, true, true, false]);

      const first = await rateLimit(freshKey(), RULE, opts());
      expect(first.remaining).toBe(RULE.limit - 1);
      expect(first.degraded).toBe(false);
    });

    it("invariant 3: when the window elapses the counter resets", async () => {
      const key = freshKey();
      for (let i = 0; i < RULE.limit; i += 1) await rateLimit(key, RULE, opts());
      const blocked = await rateLimit(key, RULE, opts());
      expect(blocked.ok).toBe(false);

      vi.setSystemTime(BASE + RULE.windowSeconds * 1000); // next window
      const allowed = await rateLimit(key, RULE, opts());
      expect(allowed.ok).toBe(true);
      expect(allowed.remaining).toBe(RULE.limit - 1);
    });

    it("invariant 4: keys are isolated", async () => {
      const a = freshKey();
      const b = freshKey();
      for (let i = 0; i < RULE.limit + 2; i += 1) await rateLimit(a, RULE, opts());
      const blockedA = await rateLimit(a, RULE, opts());
      const freshB = await rateLimit(b, RULE, opts());
      expect(blockedA.ok).toBe(false);
      expect(freshB.ok).toBe(true);
      expect(freshB.remaining).toBe(RULE.limit - 1);
    });

    it("invariant 5: result fields, allowed-headers, and the 429 response are accurate", async () => {
      const key = freshKey();
      const allowed = await rateLimit(key, RULE, opts());
      expect(allowed.limit).toBe(RULE.limit);
      expect(allowed.remaining).toBe(RULE.limit - 1);
      expect(allowed.resetAt.getTime()).toBe(BASE + RULE.windowSeconds * 1000);

      const headers = rateLimitHeaders(allowed);
      expect(headers["RateLimit-Limit"]).toBe("3");
      expect(headers["RateLimit-Remaining"]).toBe("2");
      expect(headers["RateLimit-Reset"]).toBe(String(RULE.windowSeconds));

      // Exhaust, then inspect the rejection + its 429 response.
      for (let i = 0; i < RULE.limit; i += 1) await rateLimit(key, RULE, opts());
      const rejected = await rateLimit(key, RULE, opts());
      expect(rejected.ok).toBe(false);
      expect(rejected.remaining).toBe(0);
      expect(rejected.retryAfterSeconds).toBeGreaterThan(0);

      const res = tooManyRequests(rejected);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe(String(rejected.retryAfterSeconds));
      expect(res.headers.get("RateLimit-Limit")).toBe("3");
      expect(res.headers.get("RateLimit-Remaining")).toBe("0");
    });

    it("invariant 5: the middleware extracts the key, passes through, then 429s", async () => {
      seq += 1;
      const ip = `203.0.113.${(seq % 250) + 1}`;
      const config = { rule: RULE, ...opts() };
      const mw = rateLimitMiddleware(config);
      const make = (): Request =>
        new Request("https://app.test/api", { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });

      for (let i = 0; i < RULE.limit; i += 1) {
        expect(await mw(make())).toBeNull(); // allowed → pass-through
      }
      const blocked = await mw(make());
      expect(blocked).not.toBeNull();
      expect(blocked?.status).toBe(429);
      expect(blocked?.headers.get("Retry-After")).not.toBeNull();
    });

    it("invariant 6: an invalid rule fails fast with a typed error and no store calls", async () => {
      const store = new ReferenceStore();
      const spy = vi.spyOn(store, "increment");
      for (const bad of [
        { limit: 0, windowSeconds: 60 },
        { limit: 3, windowSeconds: 0 },
        { limit: 1.5, windowSeconds: 60 },
        { limit: 3, windowSeconds: -1 },
      ] satisfies RateLimitRule[]) {
        await expect(rateLimit(freshKey(), bad, { store })).rejects.toMatchObject({
          name: "RateLimitError",
          code: "invalid_rule",
        });
      }
      expect(spy).not.toHaveBeenCalled();
    });
  },
);

describe("conformance: ratelimit.api@1 · store-failure policy (invariant 7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("invariant 7a: a store failure fails OPEN by default — allowed, flagged degraded", async () => {
    const res = await rateLimit(freshKey(), RULE, { store: new FailingStore() });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(true);
    expect(res.remaining).toBe(RULE.limit); // couldn't count → assume full budget
  });

  it("invariant 7b: fail-closed on opt-in — rejected, flagged degraded, no exception escapes", async () => {
    const res = await rateLimit(freshKey(), RULE, { store: new FailingStore(), failOpen: false });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("invariant 7: the underlying store error never escapes as an untyped exception", async () => {
    // Whatever the policy, callers only ever see typed results or RateLimitError —
    // never the raw "connection refused" from the store.
    const open = await rateLimit(freshKey(), RULE, { store: new FailingStore() }).catch(
      (e: unknown) => e,
    );
    expect(open).not.toBeInstanceOf(Error);
    const closed = rateLimitMiddleware({ rule: RULE, store: new FailingStore(), failOpen: false });
    const out = await closed(
      new Request("https://app.test/api", { headers: { "x-forwarded-for": "8.8.8.8" } }),
    ).catch((e: unknown) => e);
    if (out instanceof Error) expect(out).toBeInstanceOf(RateLimitError);
    else expect(out?.status).toBe(429);
  });
});
