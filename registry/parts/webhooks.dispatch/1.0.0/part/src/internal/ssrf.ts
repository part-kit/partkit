/**
 * SSRF defense for outbound delivery (contract invariant 6). Zero-dependency:
 * node:net / node:dns / node:http(s).
 *
 * The rebinding-proof strategy is RESOLVE → VALIDATE → CONNECT-BY-IP: at delivery
 * we resolve the host ourselves, refuse if ANY resolved address is non-public,
 * then connect to that exact validated IP (passing `servername` so TLS SNI + cert
 * validation still use the real hostname). Because we dial the IP we validated —
 * not the hostname — Node never re-resolves, so there is no DNS-rebinding TOCTOU
 * window. (We do NOT rely on the native `request({ blockList })` option: it is
 * honored only for plain http, not https, so it cannot guard the https-only
 * delivery path. Global fetch is unusable for the same zero-dep reason.)
 */
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** Build the shared private-range blocklist (IPv4 + IPv6). */
function buildBlockList(): net.BlockList {
  const bl = new net.BlockList();
  // IPv4 — non-public ranges.
  bl.addSubnet("0.0.0.0", 8, "ipv4"); // "this host" / unspecified
  bl.addSubnet("10.0.0.0", 8, "ipv4"); // RFC-1918
  bl.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT (RFC 6598; used internally by clouds)
  bl.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  bl.addSubnet("169.254.0.0", 16, "ipv4"); // link-local (covers 169.254.169.254)
  bl.addSubnet("172.16.0.0", 12, "ipv4"); // RFC-1918
  bl.addSubnet("192.168.0.0", 16, "ipv4"); // RFC-1918
  bl.addAddress("169.254.169.254", "ipv4"); // cloud metadata — explicit, defense-in-depth
  // IPv6 — non-public ranges. Do NOT add ::ffff:0:0/96: BlockList already maps
  // IPv4-mapped IPv6 to the IPv4 rules above; an explicit rule would over-block
  // v4-mapped PUBLIC addresses (e.g. ::ffff:8.8.8.8).
  bl.addAddress("::", "ipv6"); // unspecified
  bl.addAddress("::1", "ipv6"); // loopback
  bl.addSubnet("fc00::", 7, "ipv6"); // unique-local (incl. fd00::/8)
  bl.addSubnet("fe80::", 10, "ipv6"); // link-local
  bl.addSubnet("fec0::", 10, "ipv6"); // deprecated site-local
  // NAT64 (RFC 6052/8215): on a NAT64/DNS64 host these translate to embedded
  // IPv4 — e.g. 64:ff9b::a9fe:a9fe → 169.254.169.254 — so they must be blocked.
  bl.addSubnet("64:ff9b::", 96, "ipv6");
  bl.addSubnet("64:ff9b:1::", 48, "ipv6");
  return bl;
}

const FULL_BLOCKLIST = buildBlockList();

const family = (f: number): "ipv4" | "ipv6" => (f === 6 ? "ipv6" : "ipv4");

/**
 * TEST-ONLY override. Honored only when NODE_ENV==="test" AND
 * WEBHOOKS_SSRF_ALLOW lists the host — so a stray production env var does
 * nothing. Conformance sets it to reach its in-process loopback receiver
 * (documented in SPEC.md#threat-model). Read lazily so tests can set it after
 * import.
 */
function allowedHosts(): ReadonlySet<string> {
  if (process.env["NODE_ENV"] !== "test") return EMPTY;
  const raw = process.env["WEBHOOKS_SSRF_ALLOW"];
  if (raw === undefined || raw === "") return EMPTY;
  return new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""));
}
const EMPTY: ReadonlySet<string> = new Set();

/** Whether a host is on the test-only allowlist (bypasses https-only + validation). */
export function isTestAllowed(host: string): boolean {
  return allowedHosts().has(host);
}

/**
 * Resolve `host` and return a validated public IP to connect to, or null if it
 * is non-public or unresolvable (fail-closed). A literal IP is checked directly;
 * a hostname is resolved (ALL records) and refused if ANY record is in a blocked
 * range (round-robin rebinding). The returned IP is what delivery dials, so the
 * validated address IS the connected address.
 */
async function resolveValidated(host: string): Promise<string | null> {
  const lit = net.isIP(host);
  if (lit !== 0) return FULL_BLOCKLIST.check(host, family(lit)) ? null : host;
  let recs: { address: string; family: number }[];
  try {
    recs = await dns.lookup(host, { all: true });
  } catch {
    return null;
  }
  if (recs.length === 0) return null;
  if (recs.some((r) => FULL_BLOCKLIST.check(r.address, family(r.family)))) return null;
  return recs[0]!.address;
}

/**
 * Advisory, register-time check: is `host` a public destination? (Delivery
 * re-validates and connects by IP — see resolveValidated.)
 */
export async function isPublicAddress(host: string): Promise<boolean> {
  if (isTestAllowed(host)) return true;
  return (await resolveValidated(host)) !== null;
}

export type DeliveryResult =
  | { kind: "response"; statusCode: number; retryAfterSeconds: number | null; latencyMs: number }
  | { kind: "network"; error: string; latencyMs: number }
  | { kind: "blocked"; error: string; latencyMs: number };

const MAX_RETRY_AFTER_SECONDS = 86_400; // cap a hostile Retry-After at 24h

function parseRetryAfter(raw: string | string[] | undefined, nowMs: number): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === "") return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, MAX_RETRY_AFTER_SECONDS);
  const when = Date.parse(v);
  if (!Number.isNaN(when)) {
    return Math.max(0, Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil((when - nowMs) / 1000)));
  }
  return null;
}

/**
 * Deliver one signed POST. For a non-allowlisted host this REQUIRES https and
 * connects to a validated IP (resolveValidated) — rebinding-proof. The response
 * body is discarded (status only), so a huge response cannot exhaust memory, and
 * an absolute deadline bounds total wall-clock so a slow-trickle endpoint cannot
 * hang the drain.
 */
export async function deliver(
  rawUrl: string,
  body: Buffer,
  headers: Record<string, string>,
  opts: { timeoutMs: number },
): Promise<DeliveryResult> {
  const start = Date.now();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "blocked", error: "malformed destination url", latencyMs: 0 };
  }
  const host = url.hostname;
  const allowInsecure = isTestAllowed(host);
  const isHttps = url.protocol === "https:";
  if (!allowInsecure && !isHttps) {
    return { kind: "blocked", error: "destination must be https", latencyMs: 0 };
  }

  // The SSRF gate: resolve + validate, then dial the validated IP. The test path
  // (allowlisted loopback) connects to the host directly.
  let connectHost = host;
  if (!allowInsecure) {
    const ip = await resolveValidated(host);
    if (ip === null) {
      // Never echo the resolved internal IP back to the caller / endpoint owner.
      return { kind: "blocked", error: "destination address is not permitted", latencyMs: 0 };
    }
    connectHost = ip;
  }

  const port = url.port !== "" ? Number(url.port) : isHttps ? 443 : 80;
  const reqOpts: https.RequestOptions = {
    host: connectHost,
    port,
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers: { ...headers, host: url.host, "content-length": String(body.length) },
    timeout: opts.timeoutMs,
    // agent:false forces a FRESH socket per delivery — never reuse or pollute a
    // shared keep-alive pool (which would skip our connect-by-IP validation).
    agent: false,
  };
  if (isHttps && connectHost !== host) {
    // We dialed the validated IP; tell TLS the real hostname for SNI + cert check.
    reqOpts.servername = host;
  }

  return new Promise<DeliveryResult>((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const done = (r: DeliveryResult): void => {
      if (!settled) {
        settled = true;
        if (deadline !== undefined) clearTimeout(deadline);
        resolve(r);
      }
    };
    const onResponse = (res: http.IncomingMessage): void => {
      const statusCode = res.statusCode ?? 0;
      const retryAfterSeconds = parseRetryAfter(res.headers["retry-after"], Date.now());
      res.destroy(); // we only need the status line + headers; drop the body
      done({ kind: "response", statusCode, retryAfterSeconds, latencyMs: Date.now() - start });
    };
    const req = isHttps ? https.request(reqOpts, onResponse) : http.request(reqOpts, onResponse);
    req.on("error", () => {
      done({ kind: "network", error: "network error", latencyMs: Date.now() - start });
    });
    // The socket `timeout` is INACTIVITY-based — a slow-trickle endpoint that
    // dribbles a byte under the interval resets it forever and never settles.
    // This ABSOLUTE deadline bounds total wall-clock so one hostile/slow endpoint
    // can never hang the drain (SPEC.md#threat-model).
    req.on("timeout", () => {
      req.destroy();
      done({ kind: "network", error: "timeout", latencyMs: Date.now() - start });
    });
    deadline = setTimeout(() => {
      req.destroy();
      done({ kind: "network", error: "timeout", latencyMs: Date.now() - start });
    }, opts.timeoutMs);
    deadline.unref?.();
    req.end(body);
  });
}
