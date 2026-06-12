/**
 * EXAMPLE SEAM — this file is OUTSIDE the boundary: copy it into your app as
 * middleware.ts (repo root) and edit freely. It is not attested.
 *
 * After copying, change the import to your alias (seams.md §1):
 *   import { rateLimitMiddleware } from "@parts/ratelimit.api";
 *
 * Two patterns below: (A) the middleware factory — the common case, a 429 or
 * pass-through; (B) the rateLimit primitive — when you want the budget headers
 * on allowed responses too.
 */
import {
  rateLimit,
  rateLimitHeaders,
  rateLimitMiddleware,
  type RateLimitConfig,
} from "../src/index";

// Rules are CODE config, not env — they're per-route policy. Tune freely.
const config: RateLimitConfig = {
  rule: { limit: 60, windowSeconds: 60 }, // 60 requests/minute per client
  // identify defaults to the client IP (x-forwarded-for / x-real-ip). Behind
  // an untrusted proxy, set your own — e.g. an authenticated user id:
  //   identify: (req) => req.headers.get("x-user-id"),
  // store defaults to the built-in per-instance memory store; hand in a
  // Redis-backed RateLimitStore here for cross-instance limiting (seams.md §3).
  // failOpen defaults to true — a store outage allows traffic, not an outage.
};

// ── Pattern A: middleware factory ───────────────────────────────────────────
const limiter = rateLimitMiddleware(config);

/** Next.js edge middleware. Returning a Response short-circuits the request. */
export async function middleware(request: Request): Promise<Response | null> {
  const limited = await limiter(request);
  if (limited !== null) return limited; // 429 + Retry-After + RateLimit-* headers
  return null; // allowed → pass through (in real Next: NextResponse.next())
}

/** Scope to API routes only — don't rate-limit static assets. */
export const matcher = ["/api/:path*"];

// ── Pattern B: the primitive, for budget headers on success ──────────────────
/** Call inside a route handler when you want RateLimit-* headers on 2xx too. */
export async function guardedHandler(request: Request): Promise<Response> {
  const userId = request.headers.get("x-user-id") ?? "anonymous";
  const result = await rateLimit(userId, config.rule);
  if (!result.ok) {
    return new Response(JSON.stringify({ error: "slow down" }), {
      status: 429,
      headers: { "content-type": "application/json", ...rateLimitHeaders(result) },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", ...rateLimitHeaders(result) },
  });
}
