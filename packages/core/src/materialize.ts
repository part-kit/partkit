import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** The selected adapter is flattened here so part code can import it statically. */
export const SELECTED_ADAPTER_DIR = path.join("adapters", "selected");

/**
 * Turn registry-side part content (which carries ALL adapters) into the
 * vendored shape: everything except `adapters/`, plus the chosen adapter
 * flattened to `adapters/selected/`.
 *
 * This is the single definition of "the vendored tree": attestation issuance
 * hashes a materialized tree, and `partkit add` materializes with the same
 * function — so the hashes agree by construction, not by parallel logic.
 *
 * Flattening (rather than keeping `adapters/<name>/`) is what lets part
 * source import the adapter statically — `../adapters/selected/adapter.js` —
 * with no dynamic imports for bundlers to choke on. Both layouts sit at the
 * same depth, so relative imports inside adapter files survive the move.
 */
export async function materializePart(
  contentDir: string,
  adapter: string | null,
  destDir: string,
): Promise<void> {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(path.dirname(destDir), { recursive: true });

  await cp(contentDir, destDir, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(contentDir, source);
      return rel !== "adapters" && !rel.startsWith(`adapters${path.sep}`);
    },
  });

  if (adapter !== null) {
    const adapterSrc = path.join(contentDir, "adapters", adapter);
    try {
      await stat(adapterSrc);
    } catch {
      throw new Error(`Adapter "${adapter}" not found in part content at ${adapterSrc}`);
    }
    await cp(adapterSrc, path.join(destDir, SELECTED_ADAPTER_DIR), { recursive: true });
  }
}
