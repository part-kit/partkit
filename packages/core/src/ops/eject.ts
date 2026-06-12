import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ATTESTATION_FILE } from "../hash.js";
import { LOCKFILE_NAME, readLockfile, writeLockfile } from "../lockfile.js";
import { syncInstalledParts } from "./agents-list.js";

export interface EjectOptions {
  name: string;
  /** Destination directory, relative to the repo root (default: ejected/<name>). */
  to?: string;
}

export interface EjectResult {
  name: string;
  from: string;
  to: string;
  warnings: string[];
}

/**
 * `partkit eject` — the sanctioned exit (docs/02 §7): move the code out of
 * the boundary, drop it from the lockfile, void the attestation, and tell the
 * agent it now owns that code. Ejection is honest exit, not failure.
 */
export async function ejectPart(repoRoot: string, opts: EjectOptions): Promise<EjectResult> {
  const lf = await readLockfile(repoRoot);
  if (!lf) throw new Error(`No ${LOCKFILE_NAME} found — run \`partkit init\` first.`);
  if (!lf.parts[opts.name]) {
    const installed = Object.keys(lf.parts).sort().join(", ") || "(none)";
    throw new Error(`${opts.name} is not installed. Installed parts: ${installed}`);
  }

  const fromRel = path.join("parts", opts.name);
  const toRel = opts.to ?? path.join("ejected", opts.name);
  const fromAbs = path.join(repoRoot, fromRel);
  const toAbs = path.resolve(repoRoot, toRel);
  if (!toAbs.startsWith(repoRoot + path.sep)) {
    throw new Error(`Eject destination must stay inside the repo: ${toRel}`);
  }
  if (toAbs.startsWith(path.join(repoRoot, "parts") + path.sep)) {
    throw new Error(`Eject destination cannot be under parts/ — that IS the boundary: ${toRel}`);
  }

  const warnings: string[] = [];
  let moved = false;
  try {
    await stat(fromAbs);
    try {
      await stat(toAbs);
      throw new Error(`Eject destination already exists: ${toRel} — pass --to <dir>.`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("already exists")) throw e;
    }
    await mkdir(path.dirname(toAbs), { recursive: true });
    await rename(fromAbs, toAbs);
    await rm(path.join(toAbs, ATTESTATION_FILE), { force: true });
    moved = true;
  } catch (e) {
    if (e instanceof Error && e.message.includes("already exists")) throw e;
    warnings.push(`parts/${opts.name} was not on disk — removed the lockfile entry only.`);
  }

  delete lf.parts[opts.name];
  await writeLockfile(repoRoot, lf);
  const agentsWarning = await syncInstalledParts(repoRoot, lf);
  if (agentsWarning !== null) warnings.push(agentsWarning);

  if (moved) {
    warnings.push(
      `You own ${toRel} now: the attestation is void, conformance no longer runs for it, ` +
        `and upgrades stop. Update imports from ${fromRel}/src/index.js to ${toRel}/src/index.js.`,
    );
    warnings.push(
      `If this part owned tables, its rows in _part_migrations remain — \`partkit migrate\` ` +
        `surfaces them as orphaned and never touches them.`,
    );
  }

  return { name: opts.name, from: fromRel, to: toRel, warnings };
}
