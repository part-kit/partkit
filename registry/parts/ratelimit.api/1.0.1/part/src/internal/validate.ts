import { RateLimitError } from "./errors";
import type { RateLimitRule } from "./types";

/**
 * Validate before any store interaction: an invalid rule fails fast with zero
 * store calls (contract invariant 6). Non-integer values are rejected too —
 * a fractional limit or window is always a programming mistake, and silently
 * flooring it would hide the bug.
 */
export function validateRule(rule: RateLimitRule): void {
  if (!Number.isInteger(rule.limit) || rule.limit <= 0) {
    throw new RateLimitError(
      "invalid_rule",
      `rule.limit must be a positive integer, got ${String(rule.limit)}`,
    );
  }
  if (!Number.isInteger(rule.windowSeconds) || rule.windowSeconds <= 0) {
    throw new RateLimitError(
      "invalid_rule",
      `rule.windowSeconds must be a positive integer, got ${String(rule.windowSeconds)}`,
    );
  }
}
