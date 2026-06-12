/**
 * Default request → key derivation: the client IP. `x-forwarded-for`'s first
 * hop is the originating client by proxy convention; `x-real-ip` is the
 * fallback. SECURITY: these headers are client-settable unless a trusted proxy
 * overwrites them — only rely on this default behind such a proxy. For
 * untrusted ingress, pass your own `identify` (seams.md §3).
 */
export function defaultIdentify(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (xff !== null) {
    const first = xff.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  const real = request.headers.get("x-real-ip")?.trim();
  if (real !== undefined && real !== "") return real;
  return null;
}

/**
 * Where requests land when `identify` yields no key: a single shared bucket.
 * This is a deliberate, documented fallback — all keyless traffic shares one
 * limit (seams.md flags the shared-bucket DoS this implies).
 */
export const FALLBACK_KEY = "__ratelimit:no-client-key__";
