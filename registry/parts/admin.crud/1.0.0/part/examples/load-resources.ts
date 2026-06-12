/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * Discover which installed parts are administrable by reading their vendored
 * contract.json files and extracting `data_ownership.reads`. Only parts that
 * declare reads contribute resources (RFC 0004).
 *
 * After copying, change the import to your alias (seams.md §1):
 *   import { collectReads } from "@parts/admin.crud";
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { collectReads, type ContractLike, type ResourceDeclaration } from "../src/index";

/**
 * Read every `parts/<name>/contract.json` under `partsDir` and return the
 * administered resources. Call once at startup (or build-time) and pass the
 * result into `admin({ resources })`.
 */
export async function loadAdminResources(partsDir: string): Promise<ResourceDeclaration[]> {
  const entries = await readdir(partsDir, { withFileTypes: true });
  const contracts: ContractLike[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(path.join(partsDir, entry.name, "contract.json"), "utf8");
      contracts.push(JSON.parse(raw) as ContractLike);
    } catch {
      // no readable contract.json in this directory — skip it
    }
  }
  return collectReads(contracts);
}
