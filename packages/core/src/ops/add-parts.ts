import { capabilityOf } from "../contract.js";
import { LOCKFILE_NAME, readLockfile } from "../lockfile.js";
import { openRegistry, type PartRegistry } from "../registry.js";
import { addPart, type AddResult } from "./add.js";
import { resolvePlan } from "./resolve.js";

/**
 * Multi-target install — the engine behind `partkit add <targets...>`. A target
 * is a part, a pack (a curated capability kit), or `part[@version][:adapter]`.
 * Packs expand to their capabilities; the resolver (resolvePlan) orders the
 * whole set, pulls in `requires`, and drops anything the lockfile already has;
 * then each part is vendored with addPart. One code path serves a single part,
 * a hand-picked list, and a whole kit.
 */

export interface ParsedTarget {
  name: string;
  version?: string;
  adapter?: string;
}

/** `email.transactional@1.0.1:postmark` → { name, version, adapter }. */
export function parseAddTarget(raw: string): ParsedTarget {
  const parts = raw.split(":");
  if (parts.length > 2) throw new Error(`Invalid target "${raw}" — at most one ':' (part:adapter).`);
  const left = parts[0]!;
  const adapter = parts[1];
  if (adapter !== undefined && adapter === "") throw new Error(`Invalid target "${raw}" — empty adapter after ':'.`);
  const at = left.indexOf("@");
  const name = at === -1 ? left : left.slice(0, at);
  const version = at === -1 ? undefined : left.slice(at + 1);
  if (name === "") throw new Error(`Invalid target "${raw}" — missing part/pack name.`);
  if (version !== undefined && version === "") throw new Error(`Invalid target "${raw}" — empty version after '@'.`);
  return { name, ...(version !== undefined && { version }), ...(adapter !== undefined && { adapter }) };
}

export interface AddPartsOptions {
  /** Raw targets: parts, packs, or `part[@version][:adapter]`. */
  targets: string[];
  registrySource?: string;
  allowCommunity?: boolean;
}

export interface AddPartsResult {
  /** Packs that were expanded, in the order given. */
  packs: { pack: string; title: string; capabilities: string[] }[];
  /** Parts vendored this run, in install order. */
  installed: AddResult[];
  /** Capabilities the lockfile already provided (skipped). */
  alreadySatisfied: { capability: string; part: string; version: string }[];
  envRequired: string[];
  migrations: string;
  seams: string[];
  notes: string[];
  /** The first part whose install threw — everything after it was not attempted. */
  failed: { part: string; error: string } | null;
  /** Parts the plan would have installed after the failure (resume by re-running). */
  notLanded: string[];
}

/**
 * Mirror addPart's adapter policy in pre-flight so a bad/unknown override fails
 * BEFORE anything is vendored (zero parts installed), not midway through.
 * Returns an error string, or null when the override is installable.
 */
async function validateOverrideAdapter(
  registry: PartRegistry,
  part: string,
  version: string,
  name: string,
  allowCommunity: boolean,
): Promise<string | null> {
  let contract;
  try {
    contract = await registry.contract(part, version);
  } catch {
    return `${part}@${version} is not in the registry.`;
  }
  if (contract.adapters.length === 0) return `${part} takes no adapter — drop ":${name}".`;
  const found = contract.adapters.find((a) => a.name === name);
  if (found === undefined) {
    return `${part} has no adapter "${name}" (have: ${contract.adapters.map((a) => a.name).join(", ")}).`;
  }
  if (found.status === "experimental") return `${part} adapter "${name}" is experimental — not installable.`;
  if (found.status === "community" && !allowCommunity) {
    return `${part} adapter "${name}" is community-tier — re-run with --allow-community.`;
  }
  return null;
}

export async function addParts(repoRoot: string, opts: AddPartsOptions): Promise<AddPartsResult> {
  if (opts.targets.length === 0) throw new Error("Nothing to add — name a part, a pack, or part:adapter.");

  const lf = await readLockfile(repoRoot);
  if (!lf) throw new Error(`No ${LOCKFILE_NAME} found — run \`partkit init\` first.`);

  const registry = await openRegistry(opts.registrySource ?? lf.registry.source);

  // capability → provider part. Override maps MUST be keyed by the resolved part
  // (what resolvePlan emits), not the capability the user typed: a multi-capability
  // part (jobs.queue also provides jobs.cron) addressed by an alias would otherwise
  // drop its version/adapter override. Also drives the pack-availability check.
  const idx = await registry.index();
  const provided = new Set<string>();
  const capToPart = new Map<string, string>();
  for (const [part, meta] of Object.entries(idx.parts)) {
    for (const p of meta.provides) {
      const cap = capabilityOf(p);
      provided.add(cap);
      capToPart.set(cap, part);
    }
  }
  const partOf = (cap: string): string => capToPart.get(cap) ?? cap;

  // Expand targets → capability list + per-part overrides (keyed by resolved part).
  // Pack `adapters` are defaults; an explicit `part:adapter` always wins.
  const capabilities: string[] = [];
  const packs: AddPartsResult["packs"] = [];
  const packAdapters = new Map<string, string>();
  const explicitAdapters = new Map<string, string>();
  const versions = new Map<string, string>();

  for (const raw of opts.targets) {
    const t = parseAddTarget(raw);
    const pack = await registry.pack(t.name);
    if (pack) {
      if (t.adapter !== undefined) {
        throw new Error(
          `"${t.name}" is a pack — set the adapter per part (e.g. email.transactional:resend), not on the pack.`,
        );
      }
      if (t.version !== undefined) {
        throw new Error(`"${t.name}" is a pack — versions are per part, not on the pack.`);
      }
      packs.push({ pack: pack.pack, title: pack.title, capabilities: pack.capabilities });
      capabilities.push(...pack.capabilities);
      for (const [cap, adapter] of Object.entries(pack.adapters)) {
        const key = partOf(cap);
        if (!packAdapters.has(key)) packAdapters.set(key, adapter);
      }
    } else {
      capabilities.push(t.name);
      const key = partOf(t.name);
      if (t.adapter !== undefined) explicitAdapters.set(key, t.adapter);
      if (t.version !== undefined) versions.set(key, t.version);
    }
  }

  // A curated pack can name capabilities that haven't shipped yet (Wave 2). Fail
  // with a roadmap-honest message rather than the resolver's bare "no provider".
  if (packs.length > 0) {
    const blocked = packs
      .map((pk) => ({ pack: pk.pack, missing: pk.capabilities.filter((c) => !provided.has(capabilityOf(c))) }))
      .filter((x) => x.missing.length > 0);
    if (blocked.length > 0) {
      const detail = blocked.map((b) => `${b.pack} still needs ${b.missing.join(", ")}`).join("; ");
      throw new Error(
        `Pack not installable yet — ${detail} (not in the registry). ` +
          `These land as those parts ship; the saas pack is fully installable today.`,
      );
    }
  }

  const plan = await resolvePlan(registry, {
    capabilities,
    lockfile: lf,
    ...(opts.allowCommunity === true && { policy: { trust: "allow-community" as const } }),
  });

  // Pre-flight: resolve AND validate the adapter for every entry BEFORE vendoring
  // anything, so an ambiguous/unknown/uninstallable adapter fails with zero parts
  // installed. Collect every problem so the user sees them all at once.
  const toInstall: { part: string; adapter?: string; version?: string }[] = [];
  const problems: string[] = [];
  for (const e of plan.install_order) {
    const version = versions.get(e.part) ?? e.version;
    const override = explicitAdapters.get(e.part) ?? packAdapters.get(e.part);
    let adapter: string | undefined;
    if (override !== undefined) {
      const problem = await validateOverrideAdapter(registry, e.part, version, override, opts.allowCommunity === true);
      if (problem !== null) {
        problems.push(problem);
        continue;
      }
      adapter = override;
    } else if (e.adapter !== null) {
      adapter = e.adapter; // the single attested adapter resolvePlan picked
    } else if (e.adapter_choices !== undefined) {
      problems.push(
        `${e.part} needs an adapter — pass "${e.part}:<${e.adapter_choices.join("|")}>"` +
          (packs.length > 0 ? ` or pin a default in the pack's \`adapters\` map.` : `.`),
      );
      continue;
    } // else: adapterless part → adapter stays undefined
    toInstall.push({
      part: e.part,
      ...(adapter !== undefined && { adapter }),
      ...(versions.has(e.part) && { version: versions.get(e.part)! }),
    });
  }
  if (problems.length > 0) {
    throw new Error(`Cannot install — fix and retry:\n  - ${problems.join("\n  - ")}`);
  }

  // Install in resolved order. Fail-fast on the first error, but report what
  // landed — addPart commits the lockfile per part, so re-running resumes.
  const installed: AddResult[] = [];
  let failed: AddPartsResult["failed"] = null;
  const notLanded: string[] = [];
  for (const item of toInstall) {
    if (failed !== null) {
      notLanded.push(item.part);
      continue;
    }
    try {
      installed.push(
        await addPart(repoRoot, {
          name: item.part,
          ...(item.adapter !== undefined && { adapter: item.adapter }),
          ...(item.version !== undefined && { version: item.version }),
          ...(opts.registrySource !== undefined && { registrySource: opts.registrySource }),
          ...(opts.allowCommunity !== undefined && { allowCommunity: opts.allowCommunity }),
        }),
      );
    } catch (e) {
      failed = { part: item.part, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    packs,
    installed,
    alreadySatisfied: plan.already_satisfied,
    envRequired: plan.env_required,
    migrations: plan.migrations,
    seams: plan.seams_to_write,
    // Drop the resolver's "choose an adapter" hints — we resolved every adapter
    // above (via override or pack default), so they'd only contradict the result.
    notes: plan.notes.filter((n) => !/choose an adapter at add time/.test(n)),
    failed,
    notLanded,
  };
}
