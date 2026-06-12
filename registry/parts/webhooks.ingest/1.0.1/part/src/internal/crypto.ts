import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { WebhookError } from "./errors";

/**
 * The security-critical primitives, defined exactly once — adapters parse
 * their scheme's wire format and MUST come through here for comparison and
 * window checks (contract invariants 2 and 3).
 */

export function hmacSha256(key: string | Buffer, content: Buffer): Buffer {
  return createHmac("sha256", key).update(content).digest();
}

export function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Timing-safe comparison (crypto.timingSafeEqual). The length check is not
 * timing-safe — signature length is public wire format, not secret material.
 */
export function timingSafeEqualBuffers(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reject signed timestamps outside ±tolerance (contract invariant 3). The
 * explicit finite-ness check matters: NaN compares false against everything,
 * so a malformed timestamp would otherwise sail through the window test.
 */
export function assertWithinWindow(
  timestampEpochSeconds: number,
  nowEpochSeconds: number,
  toleranceSeconds: number,
): void {
  if (
    !Number.isFinite(timestampEpochSeconds) ||
    Math.abs(nowEpochSeconds - timestampEpochSeconds) > toleranceSeconds
  ) {
    throw new WebhookError(
      "timestamp_out_of_window",
      `signed timestamp is outside the ±${toleranceSeconds}s tolerance window (replay defense)`,
    );
  }
}
