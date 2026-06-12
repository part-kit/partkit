import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const ATTESTATION_FILE = "ATTESTATION.json";
const IGNORED_BASENAMES = new Set([".DS_Store"]);

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    if (IGNORED_BASENAMES.has(e.name)) continue;
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(root, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 * Deterministic content hash of a part directory: sorted relative paths
 * (posix separators), each contributing `path NUL sha256(bytes)`.
 * ATTESTATION.json is excluded — the attestation signs this hash, so it cannot
 * be part of it. Hash a MATERIALIZED tree (see materialize.ts): registry-side
 * attestation issuance and post-install verification both hash the same shape.
 */
export async function hashPartDir(dir: string): Promise<string> {
  const files = (await walk(dir)).filter((f) => f !== ATTESTATION_FILE);
  files.sort();
  const h = createHash("sha256");
  for (const rel of files) {
    const data = await readFile(path.join(dir, rel));
    h.update(rel);
    h.update("\0");
    h.update(createHash("sha256").update(data).digest());
  }
  return `sha256:${h.digest("hex")}`;
}
