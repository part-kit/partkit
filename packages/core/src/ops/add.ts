import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { capabilityOf, effectiveNpmDependencies } from "../contract.js";
import {
  LOCKFILE_NAME,
  readLockfile,
  writeLockfile,
  type LockfileEntry,
} from "../lockfile.js";
import { openRegistry } from "../registry.js";
import { vendorPart } from "../vendor.js";
import { syncInstalledParts } from "./agents-list.js";
import { applyNpmDependencies, depPlanWarnings, planNpmDependencies } from "./npm-deps.js";

export interface AddOptions {
  name: string;
  version?: string;
  adapter?: string;
  registrySource?: string;
  allowCommunity?: boolean;
}

export interface AddResult {
  name: string;
  version: string;
  adapter: string | null;
  contentHash: string;
  envKeys: string[];
  seamsPath: string;
  /** RFC 0001: entries merged into the app's package.json, and ones it already had. */
  npmDependencies: { added: Record<string, string>; satisfied: string[] };
  warnings: string[];
}

/** `partkit add` per docs/01 FR2: vendor (selected adapter only), pin, scaffold env, update AGENTS.md. */
export async function addPart(repoRoot: string, opts: AddOptions): Promise<AddResult> {
  const lf = await readLockfile(repoRoot);
  if (!lf) throw new Error(`No ${LOCKFILE_NAME} found — run \`partkit init\` first.`);

  const registry = await openRegistry(opts.registrySource ?? lf.registry.source);
  const idx = await registry.index();
  const meta = idx.parts[opts.name];
  if (!meta) {
    const available = Object.keys(idx.parts).sort().join(", ") || "(registry is empty)";
    throw new Error(`Unknown part: ${opts.name}. Available: ${available}`);
  }
  const version = opts.version ?? meta.latest;
  if (!meta.versions.includes(version)) {
    throw new Error(
      `${opts.name} has no version ${version} (available: ${meta.versions.join(", ")})`,
    );
  }
  if (lf.parts[opts.name]) {
    throw new Error(`${opts.name} is already installed — upgrades go through \`partkit upgrade\`.`);
  }

  const contract = await registry.contract(opts.name, version);

  // The anti-sprawl rule (docs/03 §4): one provider per capability per repo.
  const requestedCaps = contract.provides.map(capabilityOf);
  for (const [installedName, entry] of Object.entries(lf.parts)) {
    const overlap = entry.provides.map(capabilityOf).filter((c) => requestedCaps.includes(c));
    if (overlap.length > 0) {
      throw new Error(
        `Capability ${overlap[0]} is already provided by installed part ${installedName} — ` +
          `one provider per capability per repo (the anti-sprawl rule). ` +
          `Use \`partkit upgrade\` or \`partkit eject\` instead.`,
      );
    }
  }

  // Adapter selection with trust policy: attested by default, community on
  // explicit opt-in, experimental never (docs/02 §4).
  let adapter: string | null = null;
  if (contract.adapters.length > 0) {
    if (opts.adapter !== undefined) {
      const found = contract.adapters.find((a) => a.name === opts.adapter);
      if (!found) {
        const names = contract.adapters.map((a) => `${a.name} (${a.status})`).join(", ");
        throw new Error(`${opts.name} has no adapter "${opts.adapter}". Adapters: ${names}`);
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
      adapter = found.name;
    } else {
      const installable = contract.adapters.filter(
        (a) => a.status === "attested" || (a.status === "community" && opts.allowCommunity === true),
      );
      if (installable.length === 1) {
        adapter = installable[0]!.name;
      } else {
        const names = contract.adapters.map((a) => `${a.name} (${a.status})`).join(", ");
        throw new Error(`Choose an adapter for ${opts.name}: ${names} — pass --adapter=<name>.`);
      }
    }
  }

  // npm_dependencies (RFC 0001 §2b): plan the package.json merge BEFORE any
  // mutation — a version conflict must fail with the repo untouched.
  const depPlan = await planNpmDependencies(
    repoRoot,
    opts.name,
    effectiveNpmDependencies(contract, adapter),
  );

  const { dest, contentHash, attestation } = await vendorPart({
    registry,
    name: opts.name,
    version,
    adapter,
    partsDir: path.join(repoRoot, "parts"),
  });

  const entry: LockfileEntry = {
    version,
    adapter,
    provides: contract.provides,
    content_hash: contentHash,
    attestation: {
      verified_at: attestation.verified_at,
      expires: attestation.expires,
      signature: attestation.signature,
      result_hash: attestation.result_hash,
    },
    provenance: `registry:${registry.source}`,
  };
  lf.parts[opts.name] = entry;
  await writeLockfile(repoRoot, lf);

  const warnings: string[] = [];

  if (depPlan !== null && Object.keys(depPlan.toAdd).length > 0) {
    await applyNpmDependencies(depPlan);
  }
  warnings.push(...depPlanWarnings(depPlan));

  // Env scaffolding into .env.example; enum keys that include the chosen
  // adapter get prefilled (BILLING_ADAPTER=stripe).
  const envKeys = Object.keys(contract.env);
  if (envKeys.length > 0) {
    const envPath = path.join(repoRoot, ".env.example");
    let existing = "";
    try {
      existing = await readFile(envPath, "utf8");
    } catch {
      existing = "";
    }
    const lines: string[] = [];
    for (const [key, spec] of Object.entries(contract.env)) {
      if (existing.includes(`${key}=`)) continue;
      const hints: string[] = [];
      if (spec.required) hints.push("required");
      if (spec.secret) hints.push("secret");
      if (spec.enum) hints.push(`one of: ${spec.enum.join(" | ")}`);
      lines.push(`# ${opts.name}${hints.length > 0 ? ` — ${hints.join(", ")}` : ""}`);
      const prefill = spec.enum && adapter !== null && spec.enum.includes(adapter) ? adapter : "";
      lines.push(`${key}=${prefill}`);
    }
    if (lines.length > 0) {
      const prefix = existing === "" ? "" : `${existing.trimEnd()}\n\n`;
      await writeFile(envPath, `${prefix}${lines.join("\n")}\n`, "utf8");
    }
  }

  const agentsWarning = await syncInstalledParts(repoRoot, lf);
  if (agentsWarning !== null) warnings.push(agentsWarning);

  let migrationEntries: string[] = [];
  try {
    migrationEntries = (await readdir(path.join(dest, "migrations"))).filter(
      (n) => n !== ".gitkeep",
    );
  } catch {
    migrationEntries = [];
  }
  if (migrationEntries.length > 0) {
    warnings.push(
      "This part ships database migrations — run `partkit migrate` (reads DATABASE_URL) before first use.",
    );
  }

  return {
    name: opts.name,
    version,
    adapter,
    contentHash,
    envKeys,
    seamsPath: path.join("parts", opts.name, "seams.md"),
    npmDependencies: {
      added: depPlan?.toAdd ?? {},
      satisfied: depPlan?.satisfied ?? [],
    },
    warnings,
  };
}
