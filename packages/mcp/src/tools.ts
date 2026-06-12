/**
 * Tool handlers for the PartKit MCP server — pure (registry, args) → object,
 * so they are testable without a transport. Response design (docs/03 §3):
 * compact and deterministic; agents reread these every session, token cost is
 * product cost. resolve_plan's shape is normative per docs/06 step 2.
 */
import {
  type PartRegistry,
  capabilityOf,
  resolvePlan,
  type ResolveInput,
  type ResolvePlan,
} from "@part-kit/core";

export interface PartSummary {
  part: string;
  latest: string;
  provides: string[];
  adapters: { name: string; status: string }[];
  env: string[];
  summary: string | null;
}

export async function searchParts(
  registry: PartRegistry,
  query: string,
): Promise<{ count: number; parts: PartSummary[] }> {
  const idx = await registry.index();
  const q = query.trim().toLowerCase();
  const parts: PartSummary[] = [];
  for (const [part, meta] of Object.entries(idx.parts).sort(([a], [b]) => a.localeCompare(b))) {
    const contract = await registry.contract(part, meta.latest);
    const summary = await registry.capabilitySummary(capabilityOf(meta.provides[0] ?? part));
    const haystack = [part, ...meta.provides, summary ?? "", ...contract.interface.exports]
      .join(" ")
      .toLowerCase();
    if (q !== "" && !haystack.includes(q)) continue;
    parts.push({
      part,
      latest: meta.latest,
      provides: meta.provides,
      adapters: contract.adapters.map((a) => ({ name: a.name, status: a.status })),
      env: Object.keys(contract.env),
      summary,
    });
  }
  return { count: parts.length, parts };
}

async function resolveVersion(
  registry: PartRegistry,
  part: string,
  version: string | undefined,
): Promise<string> {
  const idx = await registry.index();
  const meta = idx.parts[part];
  if (meta === undefined) {
    const available = Object.keys(idx.parts).sort().join(", ") || "(registry is empty)";
    throw new Error(`Unknown part: ${part}. Available: ${available}`);
  }
  const v = version ?? meta.latest;
  if (!meta.versions.includes(v)) {
    throw new Error(`${part} has no version ${v} (available: ${meta.versions.join(", ")})`);
  }
  return v;
}

export async function getContract(
  registry: PartRegistry,
  part: string,
  version?: string,
): Promise<{ part: string; version: string; contract: unknown }> {
  const v = await resolveVersion(registry, part, version);
  return { part, version: v, contract: await registry.contract(part, v) };
}

export async function getSeams(
  registry: PartRegistry,
  part: string,
  version?: string,
): Promise<{ part: string; version: string; seams: string }> {
  const v = await resolveVersion(registry, part, version);
  return { part, version: v, seams: await registry.seams(part, v) };
}

export async function getAttestation(
  registry: PartRegistry,
  part: string,
  version?: string,
  adapter?: string | null,
  now: Date = new Date(),
): Promise<{ attestation: unknown; fresh: boolean; note: string }> {
  const v = await resolveVersion(registry, part, version);
  const att = await registry.attestation(part, v, adapter ?? null);
  const fresh = new Date(att.expires).getTime() >= now.getTime();
  return {
    attestation: att,
    fresh,
    note: fresh
      ? `verified ${att.verified_at}, expires ${att.expires}`
      : `EXPIRED ${att.expires} — staleness warns, it never hard-fails (docs/02 §5); integrity mismatches do.`,
  };
}

export async function getUpgradePlan(
  registry: PartRegistry,
  part: string,
  from: string,
  to: string,
): Promise<{
  part: string;
  from: string;
  to: string;
  available: boolean;
  reason: string;
  seam_changes: string[];
}> {
  await resolveVersion(registry, part, to); // loud on unknown part/version
  const base = { part, from, to, seam_changes: [] as string[] };
  if (from === to) {
    return { ...base, available: false, reason: `${part} is already at ${to} — nothing to do.` };
  }
  // Honest v0: `partkit upgrade` is unbuilt (docs/07 §5) and no part has more
  // than one published version, so no migration path can exist yet.
  return {
    ...base,
    available: false,
    reason:
      `No upgrade path is published from ${from} to ${to} — \`partkit upgrade\` is on the ` +
      `infrastructure queue (docs/07 §5). Migration dirs ship with each minor/major when it lands.`,
  };
}

export async function resolvePlanTool(
  registry: PartRegistry,
  input: ResolveInput,
): Promise<ResolvePlan> {
  return resolvePlan(registry, input);
}
