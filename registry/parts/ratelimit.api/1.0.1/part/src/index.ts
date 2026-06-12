/**
 * ratelimit.api — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 */
import { RateLimitError } from "./internal/errors";
import { defaultIdentify, FALLBACK_KEY } from "./internal/key";
import { MemoryStore } from "./internal/memory-store";
import type {
  RateLimitConfig,
  RateLimitOpts,
  RateLimitResult,
  RateLimitRule,
} from "./internal/types";
import { validateRule } from "./internal/validate";

export { RateLimitError } from "./internal/errors";
export type { RateLimitErrorCode } from "./internal/errors";
export type {
  RateLimitConfig,
  RateLimitOpts,
  RateLimitResult,
  RateLimitRule,
  RateLimitStore,
} from "./internal/types";

/**
 * The built-in store is a module-scope singleton — re-created per cold start,
 * the only sanctioned in-memory state under serverless (docs/02 §2). Its
 * limitation (not shared across instances) is the reason the store is a seam.
 */
const defaultStore = new MemoryStore();

function secondsUntil(resetAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((resetAtMs - nowMs) / 1000));
}

/**
 * Check (and consume) one unit of `key`'s budget under `rule`.
 *
 * Importing this module performs no I/O; the rule is validated here, at call
 * time, with a typed error (contract invariants 1, 6). The window is fixed:
 * the key's counter resets at each `windowSeconds` boundary. A store failure
 * never throws — it resolves to a degraded result per `failOpen` (invariant 7),
 * so a backend outage cannot take the whole API down with it.
 */
export async function rateLimit(
  key: string,
  rule: RateLimitRule,
  opts: RateLimitOpts = {},
): Promise<RateLimitResult> {
  validateRule(rule);
  const store = opts.store ?? defaultStore;
  const failOpen = opts.failOpen ?? true;

  const nowMs = Date.now();
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const resetAtMs = windowStart + windowMs;
  const bucketKey = `${key}:${windowStart}`;

  let count: number;
  try {
    count = await store.increment(bucketKey, rule.windowSeconds);
  } catch {
    // Raw store error (which may embed credentials) is swallowed, never
    // surfaced — the policy decides allow vs reject (invariant 7).
    return {
      ok: failOpen,
      limit: rule.limit,
      remaining: failOpen ? rule.limit : 0,
      resetAt: new Date(resetAtMs),
      retryAfterSeconds: Math.max(1, secondsUntil(resetAtMs, nowMs)),
      degraded: true,
    };
  }

  const ok = count <= rule.limit;
  const secs = secondsUntil(resetAtMs, nowMs);
  return {
    ok,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    resetAt: new Date(resetAtMs),
    retryAfterSeconds: ok ? secs : Math.max(1, secs),
    degraded: false,
  };
}

/**
 * IETF-draft `RateLimit-*` headers for a result — attach to ANY response
 * (allowed or rejected) so clients can self-throttle (contract invariant 5).
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(result.retryAfterSeconds),
  };
}

/** A ready-to-return 429 with `Retry-After` and the `RateLimit-*` headers. */
export function tooManyRequests(result: RateLimitResult): Response {
  return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "Retry-After": String(result.retryAfterSeconds),
      ...rateLimitHeaders(result),
    },
  });
}

/**
 * Middleware factory (contract export): returns a function that resolves to a
 * `429` Response when the request is over the limit, or `null` to pass through.
 *
 * Constructing the middleware does no I/O and never throws (serverless-safe);
 * config is validated when the returned function runs. To emit `RateLimit-*`
 * headers on ALLOWED responses too, apply `rateLimitHeaders` to your own
 * response (seams.md §2) — middleware that passes through cannot attach them.
 */
export function rateLimitMiddleware(
  config: RateLimitConfig,
): (request: Request) => Promise<Response | null> {
  return async (request: Request): Promise<Response | null> => {
    const identify = config.identify ?? defaultIdentify;
    if (typeof identify !== "function") {
      throw new RateLimitError(
        "invalid_config",
        "config.identify must be a function (request) => string | null",
      );
    }
    let derived: string | null;
    try {
      derived = identify(request);
    } catch (e) {
      throw new RateLimitError(
        "invalid_config",
        `config.identify threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const key = derived === null || derived === "" ? FALLBACK_KEY : derived;

    const result = await rateLimit(key, config.rule, {
      ...(config.store !== undefined && { store: config.store }),
      ...(config.failOpen !== undefined && { failOpen: config.failOpen }),
    });
    return result.ok ? null : tooManyRequests(result);
  };
}
