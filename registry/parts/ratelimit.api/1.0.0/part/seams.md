# Seams — ratelimit.api

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested
interior; edits void the attestation and fail CI).

## 1. No environment, no adapter — configured in code

This part reads **no env vars** and ships **no registry adapters**. Rate-limit
rules are per-route policy, so they live in your code, not in `.env`. Import
and configure:

```jsonc
// tsconfig.json → compilerOptions (recommended alias)
"paths": { "@parts/*": ["./parts/*/src"] }
```

```ts
import { rateLimitMiddleware, rateLimit, rateLimitHeaders } from "@parts/ratelimit.api";
```

Plain relative imports of `parts/ratelimit.api/src/index.js` work too.
Never deep-import `src/internal/**` (lint-enforced).

## 2. The middleware seam (the common case)

`rateLimitMiddleware(config)` returns `(request) => Promise<Response | null>`:
a `429` Response when over the limit, `null` to pass through. Start from
`examples/next-middleware.ts` (outside the boundary, freely copyable):

```ts
const limiter = rateLimitMiddleware({ rule: { limit: 60, windowSeconds: 60 } });

export async function middleware(req: Request) {
  const limited = await limiter(req);
  return limited ?? NextResponse.next();
}
export const config = { matcher: ["/api/:path*"] };
```

A `429` carries `Retry-After` and the IETF `RateLimit-Limit / -Remaining /
-Reset` headers. To advertise the budget on **allowed** responses too, call
the `rateLimit` primitive in your handler and apply `rateLimitHeaders(result)`
to your own response — middleware that passes through cannot attach them.

## 3. The store seam — bring Redis for cross-instance limiting

The built-in store is in-memory and **per instance** (§6). For real limits
across a serverless fleet, pass a `RateLimitStore`:

```ts
interface RateLimitStore {
  // Atomically increment the counter at bucketKey, return the NEW value, and
  // expire the entry after ttlSeconds. Redis: INCR then EXPIRE.
  increment(bucketKey: string, ttlSeconds: number): Promise<number> | number;
}
```

Reference Redis (ioredis) implementation:

```ts
const store: RateLimitStore = {
  async increment(bucketKey, ttlSeconds) {
    const n = await redis.incr(bucketKey);
    if (n === 1) await redis.expire(bucketKey, ttlSeconds);
    return n;
  },
};
rateLimitMiddleware({ rule, store });
```

**Atomicity matters:** the count is only correct if `increment` is atomic per
`bucketKey`. `INCR` is; a get-then-set is not and will undercount under load.

## 4. Identifying the client — the trust boundary

`identify(request)` derives the key. Default: the client IP — first
`x-forwarded-for` hop, then `x-real-ip`.

> **Security:** those headers are client-settable unless a trusted proxy
> overwrites them. Behind Vercel/Cloudflare/your LB the default is fine; on
> untrusted ingress an attacker spoofs `x-forwarded-for` to dodge the limit.
> Then supply your own `identify` — an authenticated user id is ideal:
> `identify: (req) => req.headers.get("x-user-id")`.

If `identify` returns `null`/empty, the request lands in a single shared
bucket — see the shared-bucket caveat in §6.

## 5. Fail-open vs fail-closed

When the store throws (Redis down), the limiter does **not** throw — it
returns a degraded result per `failOpen`:

- `failOpen: true` (default) — request **allowed**, `result.degraded === true`.
  A store outage must not become an API outage.
- `failOpen: false` — request **rejected**. Use only for abuse-critical
  endpoints where blocking beats letting traffic through unmetered.

`RateLimitError` is thrown only for programming mistakes (`invalid_rule`,
`invalid_config`), never for a store failure.

## 6. What v1 does and does not give you

- **Per-instance counting.** The built-in store lives in one process's memory;
  N serverless instances enforce N× the limit in aggregate. Use a shared
  store (§3) for a true global limit. Durable, cross-instance counting without
  external infra arrives as an additive minor with the DB story.
- **Shared-bucket DoS.** Keyless requests share one bucket, so one client can
  exhaust it for all keyless traffic. Always set a real `identify` (§4) in
  production.
- **Fixed window, not sliding.** A burst straddling a window boundary can send
  up to `2 × limit` in a short span. Sliding-window is a future capability.

## 7. What you must NOT do

- Edit or import anything under `src/internal/**`.
- Trust the default IP key on untrusted ingress (§4).
- Treat a `429` or a `degraded` result as a bug — they are the limiter working.
- Use a non-atomic custom store (§3).
