/**
 * Regression guard: a pack that bundles a MULTI-adapter part must pin a default
 * adapter for it, or `partkit add <pack>` dies with "needs an adapter" for a
 * stranger. This bit us when billing.subscription gained a 2nd adapter (paddle)
 * and the saas/marketplace packs still assumed the old auto-select. Reads the
 * REAL registry (packs + part contracts), so adding an adapter to any part
 * without updating the packs that use it fails here, not in a user's terminal.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REGISTRY = fileURLToPath(new URL("../../../registry", import.meta.url));
const index = JSON.parse(readFileSync(path.join(REGISTRY, "index.json"), "utf8")) as {
  parts: Record<string, { latest: string }>;
};

/** Attested adapter names for a part's latest version ([] = adapterless). */
function adaptersOf(part: string): string[] {
  const latest = index.parts[part]?.latest;
  if (latest === undefined) return [];
  const contract = JSON.parse(
    readFileSync(path.join(REGISTRY, "parts", part, latest, "part", "contract.json"), "utf8"),
  ) as { adapters?: { name: string }[] };
  return (contract.adapters ?? []).map((a) => a.name);
}

const packFiles = readdirSync(path.join(REGISTRY, "packs")).filter((f) => f.endsWith(".json"));

describe("registry packs: a multi-adapter part must pin a default so `partkit add <pack>` resolves", () => {
  it("there is at least one pack to check", () => {
    expect(packFiles.length).toBeGreaterThan(0);
  });

  for (const file of packFiles) {
    const pack = JSON.parse(readFileSync(path.join(REGISTRY, "packs", file), "utf8")) as {
      parts?: string[];
      capabilities?: string[];
      adapters?: Record<string, string>;
    };
    const entries = pack.parts ?? pack.capabilities ?? [];
    const defaults = pack.adapters ?? {};

    it(`${file}: every multi-adapter part pins a valid default`, () => {
      for (const entry of entries) {
        const part = entry.split("@")[0]!; // tolerate a capability "@1" suffix
        const adapters = adaptersOf(part);
        if (adapters.length > 1) {
          const pinned = defaults[part];
          expect(
            pinned,
            `${file} bundles ${part} (${adapters.length} adapters: ${adapters.join("/")}) but pins no default — \`partkit add ${file.replace(".json", "")}\` would fail for a stranger`,
          ).toBeDefined();
          expect(
            adapters,
            `${file} pins ${part}:${String(pinned)} which is not an attested adapter (${adapters.join("/")})`,
          ).toContain(pinned);
        }
      }
    });
  }
});
