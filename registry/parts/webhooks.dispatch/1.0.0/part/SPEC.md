# webhooks.dispatch — design notes & threat model

`webhooks.dispatch` is the verified **outbound** webhook sender: register
customer endpoints, dispatch signed events to a transactional outbox (never
inline), and deliver out-of-band with retry, capped backoff, a delivery log,
dead-letter, and SSRF defense. It is the API-facing sibling of `webhooks.ingest`
and reuses the **same Standard Webhooks signature**, so a customer who can verify
an inbound webhooks.ingest payload verifies ours with the same code.

Zero-dependency (node:crypto / node:dns / node:https) and driver-free (the
`SqlExecutor` app seam). It owns `webhooks_dispatch_endpoints`, `…_outbox`, and
`…_attempts`, and reads no env. Requires **Node ≥22.13** for the SSRF gate.

## Dispatch is enqueue-only; delivery is out-of-band

`dispatch` validates, persists one outbox row, and returns a `messageId` — it
performs **no HTTP**. A slow or hostile customer endpoint therefore cannot block
or fail the request that triggered the event. Delivery happens only in
`deliverDue`, which is meant to run on a schedule (under `jobs.queue` or a plain
cron). The outbox carries its own retry state (`status`, `attempt_count`,
`next_attempt_at`), so `deliverDue` is a self-contained drainer and the part owns
retry/backoff/dead-letter without a hard dependency on `jobs.queue` (RFC 0003
§4): the queue is a clock, not the retry engine.

## Signing — byte-identical Standard Webhooks

Each delivery is HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed by the
base64-decoded `whsec_…` secret, emitted as `webhook-id` / `webhook-timestamp`
(unix seconds) / `webhook-signature` (`v1,<standard-base64>`). This is the SEND
side of the exact scheme `webhooks.ingest`'s `standardwebhooks` adapter verifies.
A conformance known-answer test pins it to the Standard Webhooks spec's own
published vector, so a wire-format drift cannot ship. Retries re-sign with a
fresh timestamp (the receiver's tolerance window would reject a stale one) while
keeping the stable `webhook-id` for receiver-side dedupe.

The signing secret is symmetric, so — unlike `auth.apikey`'s one-way hash — the
part **must store it** to sign each delivery. It is returned to the owner once at
registration and never again, and never appears in errors, logs, or
`listAttempts`; the `endpoints` table is a credential store (see threat model).

## SSRF defense — resolve → validate → connect-by-IP

The decisive constraint is zero-dependency. Global `fetch` cannot be made
SSRF-safe without an npm dispatcher (undici), and the native
`request({ blockList })` option is honored only for plain http, **not https** —
so it cannot guard the https-only delivery path. Delivery instead does
**resolve → validate → connect-by-IP**: resolve the host ourselves, refuse if any
resolved address is non-public, then dial that exact validated IP (passing
`servername` so TLS SNI + certificate validation still use the real hostname).
Because we connect to the IP we validated — never the hostname — Node never
re-resolves, so **the validated address IS the connected address** and there is
no DNS-rebinding TOCTOU window.

Two enforcement points:

- **registerEndpoint** runs `isPublicAddress(host)` — https-only, `dns.lookup`
  ALL records, refuse if **any** resolves into a blocked range (round-robin
  rebinding), fail-closed on empty/failed resolution. A friendly up-front
  rejection; **advisory** because DNS can change later.
- **delivery** re-resolves and validates every record, then connects to a
  validated IP. A non-public destination is recorded as a failed delivery
  (retry/backoff), never silently skipped, and the resolved internal IP is never
  echoed back to the caller. Each delivery uses a **fresh socket** (`agent:false`)
  so a shared keep-alive pool can never serve a connection that skipped this gate.

The blocklist covers IPv4 `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`,
`169.254/16` (+ explicit `169.254.169.254`), `172.16/12`, `192.168/16` and IPv6
`::`, `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10`, and the NAT64 prefixes
`64:ff9b::/96` + `64:ff9b:1::/48` (which translate to embedded IPv4 on a NAT64
host). It deliberately omits `::ffff:0:0/96`: `net.BlockList` already maps
IPv4-mapped IPv6 to the IPv4 rules, and an explicit rule would over-block
v4-mapped **public** addresses. Redirects are never followed (a `3xx` could point
at a private host). The response body is discarded (status only), and an
**absolute per-delivery deadline** bounds wall-clock so a slow-trickle endpoint
(which a socket-inactivity timeout never catches) cannot hang the sequential
drain; a per-pass time budget bounds a single `deliverDue` run.

## Retry, backoff, dead-letter

Network error / `5xx` / `429` are transient: retried with capped exponential
backoff (base 60s, ×2, cap 1h) up to 6 attempts, then **dead-letter**
(`status = 'dead'`). A `429`'s `Retry-After` overrides the computed backoff
(capped at 24h to defang a hostile value). A `4xx` other than `429` is permanent
— dead-lettered without retry. Every attempt (outcome, status, latency,
next-retry) is recorded in `webhooks_dispatch_attempts` and read via
`listAttempts`. Delivery is **at-least-once**: retries and concurrent drains may
redeliver; the stable `webhook-id` is for receiver-side dedupe.

## <a id="threat-model"></a>Threat model

| Threat | Mitigation |
|---|---|
| **SSRF into internal services / cloud metadata** | https-only + a `net.BlockList` of all private ranges (incl. CGNAT, NAT64, site-local). At delivery we resolve, validate every record, and connect to the validated IP — refused destinations never connect. Refused at registration too. Redirects never followed. |
| **DNS rebinding** (public at register, private at delivery) | Delivery re-resolves and connects to the validated IP itself, not the hostname, so Node never re-resolves — the validated IP IS the connected IP (no TOCTOU). A fresh socket per delivery (`agent:false`) prevents a pooled keep-alive socket from bypassing the gate. |
| **Slow / hostile endpoint stalling the caller** | `dispatch` never delivers inline; delivery is out-of-band with a bounded per-request timeout; the response body is discarded (status only) so a huge response can't exhaust memory. |
| **Forged / tampered deliveries** (customer trust) | Every delivery carries a Standard Webhooks HMAC over the exact bytes sent; any tampered byte fails the customer's verification (pinned to the spec's known-answer vector). |
| **Replay** | Stable `webhook-id` lets the receiver dedupe; retries re-sign with a fresh timestamp so they stay inside the receiver's tolerance window. |
| **Lost / silently-dropped events** | Transactional outbox + recorded attempts + dead-letter; nothing is dropped, and the full delivery log is queryable. |
| **Duplicate enqueue** | `idempotencyKey` unique per endpoint → one outbox row; a NULL key never dedupes. |
| **SQL injection via endpoint/event metadata** | Constant statements, positional parameters only; statements touch only `webhooks_dispatch_*` tables. |
| **Secret leakage** | The signing secret is returned once, lives only in the `endpoints` table to sign, and never appears in errors, logs, or `listAttempts`; `storage` errors keep the raw driver error on `.cause` with a generic `.message`. The `endpoints` table is a credential store — protect the database. |
| **Hostile `Retry-After` / payload size** | `Retry-After` capped at 24h; payload bounded at 256 KB at dispatch. |

### Test-only SSRF override

Conformance must deliver to its in-process fake receiver on `127.0.0.1`, which
the guard blocks by default. The env var **`WEBHOOKS_SSRF_ALLOW`** (comma-
separated hosts) bypasses the https-only + blocklist checks **for the listed
hosts only**, and is honored **only when `NODE_ENV==="test"`** — so a stray
production env var does nothing. **Never set it in production.** The suite sets
`WEBHOOKS_SSRF_ALLOW=127.0.0.1,::1` and keeps one test with it OFF asserting
loopback delivery is refused, so the guard is proven present, not bypassed.

### Out of scope (v1, see RFC 0003 §5)

A customer-facing endpoint-management UI (an `examples/` seam), per-endpoint
circuit-breaker / auto-disable after sustained failure, and a replay-from-
dead-letter operator action are additive futures.
