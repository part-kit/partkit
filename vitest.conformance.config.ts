import { defineConfig } from "vitest/config";

/**
 * Used by scripts/publish-part.mjs: runs a part's conformance suite against
 * the materialized tree in .partkit-work/current/ (one adapter at a time).
 */
export default defineConfig({
  test: {
    include: [".partkit-work/current/conformance/**/*.test.ts"],
  },
});
