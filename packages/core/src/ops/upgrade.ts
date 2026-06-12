import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ContractSchema, effectiveNpmDependencies, type Contract } from "../contract.js";
import { LOCKFILE_NAME, readLockfile, writeLockfile } from "../lockfile.js";
import { openRegistry, type PartRegistry } from "../registry.js";
import { vendorPart } from "../vendor.js";
import { syncInstalledParts } from "./agents-list.js";
import { applyNpmDependencies, depPlanWarnings, planNpmDependencies } from "./npm-deps.js";

export interface UpgradeOptions {
  name: string;
  /** Target version (default: registry latest). */
  version?: string;
  /** Target adapter (default: keep the installed one). This is "the flip". */
  adapter?: string;
  registrySource?: string;
  allowCommunity?: boolean;
}

export interface UpgradeResult {
  name: string;
  from: { version: string; adapter: string | null };
  to: { version: string; adapter: string | null };
  changed: boolean;
  contentHash: string;
  /** Contents of the registry's seam-changes.md for this hop, when published. */
  seamChanges: string | null;
  npmDependencies: { added: Record<string, string>; satisfied: string[]; obsolete: string[] };
  warnings: string[];
}

/**
 * `partkit upgrade` (docs/02 §6, docs/03 §2): interiors change mechanically —
 * vendored tree, lockfile pin, env prefill — and the agent is handed only the
 * declared seam changes. An adapter flip at the same version is the canonical
 * one-commit vendor swap: lockfile + adapters/selected/ + one env line, zero
 * seam changes, because the contract didn't move.
 */
export async function upgradePart(repoRoot: string, opts: UpgradeOptions): Promise<UpgradeResult> {
  const lf = await readLockfile(repoRoot);
  if (!lf) throw new Error(`No ${LOCKFILE_NAME} found — run \`partkit init\` first.`);
  const entry = lf.parts[opts.name];
  if (!entry) {
    throw new Error(`${opts.name} is not installed — \`partkit add ${opts.name}\` first.`);
  }

  const registry = await openRegistry(opts.registrySource ?? lf.registry.source);
  const idx = await registry.index();
  const meta = idx.parts[opts.name];
  if (!meta) throw new Error(`${opts.name} no longer exists in the registry.`);
  const toVersion = opts.version ?? meta.latest;
  if (!meta.versions.includes(toVersion)) {
    throw new Error(
      `${opts.name} has no version ${toVersion} (available: ${meta.versions.join(", ")})`,
    );
  }

  const contract = await registry.contract(opts.name, toVersion);
  const toAdapter = resolveAdapter(contract, opts, entry.adapter);

  const from = { version: entry.version, adapter: entry.adapter };
  const to = { version: toVersion, adapter: toAdapter };
  if (from.version === to.version && from.adapter === to.adapter) {
    return {
      name: opts.name,
      from,
      to,
      changed: false,
      contentHash: entry.content_hash,
      seamChanges: null,
      npmDependencies: { added: {}, satisfied: [], obsolete: [] },
      warnings: [`${opts.name} is already at ${to.version} (adapter: ${to.adapter ?? "none"}).`],
    };
  }

  // Old effective deps from the currently vendored contract — to report what
  // the new selection no longer needs (never auto-removed; apps may share deps).
  const oldDeps = await installedDeps(repoRoot, opts.name, entry.adapter);
  const newDeps = effectiveNpmDependencies(contract, toAdapter);
  const depPlan = await planNpmDependencies(repoRoot, opts.name, newDeps);
  const obsolete = Object.keys(oldDeps)
    .filter((d) => !(d in newDeps))
    .sort();

  // Vendor into a temp dir first: if integrity fails, the installed part
  // must survive untouched.
  const partsDir = path.join(repoRoot, "parts");
  const tempDir = path.join(partsDir, ".upgrade-tmp");
  let result;
  try {
    result = await vendorPart({
      registry,
      name: opts.name,
      version: toVersion,
      adapter: toAdapter,
      partsDir: tempDir,
    });
    await rm(path.join(partsDir, opts.name), { recursive: true, force: true });
    await rename(result.dest, path.join(partsDir, opts.name));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  lf.parts[opts.name] = {
    version: toVersion,
    adapter: toAdapter,
    provides: contract.provides,
    content_hash: result.contentHash,
    attestation: {
      verified_at: result.attestation.verified_at,
      expires: result.attestation.expires,
      signature: result.attestation.signature,
      result_hash: result.attestation.result_hash,
    },
    provenance: `registry:${registry.source}`,
  };
  await writeLockfile(repoRoot, lf);

  const warnings: string[] = [];
  if (depPlan !== null && Object.keys(depPlan.toAdd).length > 0) {
    await applyNpmDependencies(depPlan);
  }
  warnings.push(...depPlanWarnings(depPlan));
  for (const dep of obsolete) {
    warnings.push(
      `${dep} is no longer needed by ${opts.name} — remove it from package.json yourself if nothing else uses it.`,
    );
  }

  await updateEnvPrefill(repoRoot, contract, from.adapter, toAdapter);

  const agentsWarning = await syncInstalledParts(repoRoot, lf);
  if (agentsWarning !== null) warnings.push(agentsWarning);

  let seamChanges: string | null = null;
  if (from.version !== to.version) {
    seamChanges = await registry.seamChanges(opts.name, from.version, to.version);
    if (seamChanges === null) {
      warnings.push(
        `No seam-changes.md is published for ${from.version} → ${to.version}; ` +
          `contract semver says interfaces only grew. If the build disagrees, the part must publish one.`,
      );
    }
    let migrationFiles: string[] = [];
    try {
      migrationFiles = (
        await readdir(path.join(partsDir, opts.name, "migrations"))
      ).filter((n) => n !== ".gitkeep");
    } catch {
      migrationFiles = [];
    }
    if (migrationFiles.length > 0) {
      warnings.push("This part ships database migrations — run `partkit migrate` (reads DATABASE_URL).");
    }
  }

  return {
    name: opts.name,
    from,
    to,
    changed: true,
    contentHash: result.contentHash,
    seamChanges,
    npmDependencies: {
      added: depPlan?.toAdd ?? {},
      satisfied: depPlan?.satisfied ?? [],
      obsolete,
    },
    warnings,
  };
}

/** Same trust policy as `add` (docs/02 §4): attested freely, community on opt-in, experimental never. */
function resolveAdapter(
  contract: Contract,
  opts: UpgradeOptions,
  current: string | null,
): string | null {
  if (contract.adapters.length === 0) {
    if (opts.adapter !== undefined) {
      throw new Error(`${contract.part} has no adapters — its backend is an app seam (seams.md).`);
    }
    return null;
  }
  const want = opts.adapter ?? current;
  if (want === null) {
    const names = contract.adapters.map((a) => `${a.name} (${a.status})`).join(", ");
    throw new Error(`Choose an adapter for ${contract.part}: ${names} — pass --adapter=<name>.`);
  }
  const found = contract.adapters.find((a) => a.name === want);
  if (!found) {
    const names = contract.adapters.map((a) => `${a.name} (${a.status})`).join(", ");
    throw new Error(`${contract.part} has no adapter "${want}". Adapters: ${names}`);
  }
  if (found.status === "experimental") {
    throw new Error(`Adapter ${found.name} is experimental — not conforming, not installable.`);
  }
  if (found.status === "community" && opts.allowCommunity !== true) {
    throw new Error(
      `Adapter ${found.name} is community-tier (conformance not run in our CI). ` +
        `Re-run with --allow-community to accept it.`,
    );
  }
  return found.name;
}

async function installedDeps(
  repoRoot: string,
  name: string,
  adapter: string | null,
): Promise<Record<string, string>> {
  try {
    const raw = await readFile(path.join(repoRoot, "parts", name, "contract.json"), "utf8");
    const parsed = ContractSchema.safeParse(JSON.parse(raw));
    return parsed.success ? effectiveNpmDependencies(parsed.data, adapter) : {};
  } catch {
    return {};
  }
}

/**
 * The env half of the flip: rewrite `KEY=<oldAdapter>` prefills to the new
 * adapter and append scaffold lines for keys the new contract introduces.
 * Lines the user changed are never touched.
 */
async function updateEnvPrefill(
  repoRoot: string,
  contract: Contract,
  oldAdapter: string | null,
  newAdapter: string | null,
): Promise<void> {
  const envPath = path.join(repoRoot, ".env.example");
  let existing = "";
  try {
    existing = await readFile(envPath, "utf8");
  } catch {
    existing = "";
  }
  let out = existing;
  const appended: string[] = [];
  for (const [key, spec] of Object.entries(contract.env)) {
    const prefill =
      spec.enum && newAdapter !== null && spec.enum.includes(newAdapter) ? newAdapter : "";
    if (out.includes(`${key}=`)) {
      if (oldAdapter !== null && prefill !== "" && out.includes(`${key}=${oldAdapter}`)) {
        out = out.replace(`${key}=${oldAdapter}`, `${key}=${prefill}`);
      }
      continue;
    }
    const hints: string[] = [];
    if (spec.required) hints.push("required");
    if (spec.secret) hints.push("secret");
    if (spec.enum) hints.push(`one of: ${spec.enum.join(" | ")}`);
    appended.push(`# ${contract.part}${hints.length > 0 ? ` — ${hints.join(", ")}` : ""}`);
    appended.push(`${key}=${prefill}`);
  }
  if (appended.length > 0) {
    out = `${out === "" ? "" : `${out.trimEnd()}\n\n`}${appended.join("\n")}\n`;
  }
  if (out !== existing) await writeFile(envPath, out, "utf8");
}

