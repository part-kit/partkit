import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Build-time data source: the repo's registry directory. Located by walking
 * up from cwd — build environments differ in where they run `next build`
 * (repo root locally, the project root on Vercel), and a wrong guess must
 * fail with a diagnostic, not a mystery.
 */
function locateRegistry(): string {
  const tried: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "registry");
    tried.push(candidate);
    if (existsSync(path.join(candidate, "index.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `partkit.dev build: registry/index.json not found. cwd=${process.cwd()} tried: ${tried.join(", ")}`,
  );
}

const REGISTRY = locateRegistry();

export interface AdapterInfo {
  name: string;
  status: "attested" | "community" | "experimental";
  vendor_api: string;
}

export interface AttestationInfo {
  adapter: string | null;
  verified_at: string;
  expires: string;
  tests_passed: number;
  signature: string;
}

export interface ContractInfo {
  part: string;
  version: string;
  provides: string[];
  requires: string[];
  adapters: AdapterInfo[];
  interface: { exports: string[]; events: string[]; http_routes: { route: string; export: string }[] };
  env: Record<string, { required: boolean; secret?: boolean; enum?: string[] }>;
  invariants: string[];
  npm_dependencies?: Record<string, string>;
}

export interface PartInfo {
  name: string;
  version: string;
  provides: string[];
  summary: string | null;
  contract: ContractInfo;
  attestations: AttestationInfo[];
  seams: string;
}

async function json<T>(...segments: string[]): Promise<T> {
  return JSON.parse(await readFile(path.join(REGISTRY, ...segments), "utf8")) as T;
}

export async function listParts(): Promise<PartInfo[]> {
  const index = await json<{ parts: Record<string, { latest: string; provides: string[] }> }>(
    "index.json",
  );
  const parts: PartInfo[] = [];
  for (const [name, meta] of Object.entries(index.parts).sort(([a], [b]) => a.localeCompare(b))) {
    const contract = await json<ContractInfo>("parts", name, meta.latest, "part", "contract.json");
    const capability = meta.provides[0]?.split("@")[0] ?? name;
    let summary: string | null = null;
    try {
      const cap = await json<{ summary?: string }>("capabilities", capability, "v1", "capability.json");
      summary = cap.summary ?? null;
    } catch {
      summary = null;
    }
    const attestations: AttestationInfo[] = [];
    try {
      for (const f of (await readdir(path.join(REGISTRY, "parts", name, meta.latest, "attestations"))).sort()) {
        if (!f.endsWith(".json")) continue;
        const a = await json<AttestationInfo>("parts", name, meta.latest, "attestations", f);
        attestations.push(a);
      }
    } catch {
      // a part without attestations never reaches the index, but stay honest
    }
    const seams = await readFile(
      path.join(REGISTRY, "parts", name, meta.latest, "part", "seams.md"),
      "utf8",
    );
    parts.push({ name, version: meta.latest, provides: meta.provides, summary, contract, attestations, seams });
  }
  return parts;
}

export async function getPart(name: string): Promise<PartInfo> {
  const part = (await listParts()).find((p) => p.name === name);
  if (!part) throw new Error(`Unknown part: ${name}`);
  return part;
}
