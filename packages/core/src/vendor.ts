import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Attestation } from "./attestation.js";
import type { Contract } from "./contract.js";
import { ATTESTATION_FILE, hashPartDir } from "./hash.js";
import { materializePart } from "./materialize.js";
import type { PartRegistry } from "./registry.js";

export interface VendorResult {
  dest: string;
  contentHash: string;
  contract: Contract;
  attestation: Attestation;
}

/**
 * Materialize a part out of the registry into `parts/<name>/` (selected
 * adapter flattened to adapters/selected/), and refuse to install unless the
 * resulting content hashes to exactly what the attestation signs — integrity
 * from the first byte.
 */
export async function vendorPart(opts: {
  registry: PartRegistry;
  name: string;
  version: string;
  adapter: string | null;
  partsDir: string;
}): Promise<VendorResult> {
  const { registry, name, version, adapter, partsDir } = opts;
  const contract = await registry.contract(name, version);
  const attestation = await registry.attestation(name, version, adapter);
  const dest = path.join(partsDir, name);

  const fetched = await registry.fetchContent(name, version);
  try {
    await materializePart(fetched.dir, adapter, dest);
  } finally {
    await fetched.cleanup();
  }

  const contentHash = await hashPartDir(dest);
  if (contentHash !== attestation.content_hash) {
    await rm(dest, { recursive: true, force: true });
    throw new Error(
      `Integrity failure: vendored content of ${name}@${version} hashes to ${contentHash}, ` +
        `but its attestation signs ${attestation.content_hash}. Refusing to install.`,
    );
  }

  await writeFile(
    path.join(dest, ATTESTATION_FILE),
    `${JSON.stringify(attestation, null, 2)}\n`,
    "utf8",
  );
  return { dest, contentHash, contract, attestation };
}
