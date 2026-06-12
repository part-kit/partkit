import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";

/**
 * npm_dependencies handling shared by `add` and `upgrade` (RFC 0001 §2b):
 * plan the package.json merge BEFORE any repo mutation — a version conflict
 * must fail with everything untouched — then apply it after the vendoring
 * and lockfile writes succeed.
 */
export interface NpmDepPlan {
  pkgPath: string;
  pkg: Record<string, unknown>;
  toAdd: Record<string, string>;
  satisfied: string[];
  devOnly: string[];
}

export async function planNpmDependencies(
  repoRoot: string,
  partName: string,
  deps: Record<string, string>,
): Promise<NpmDepPlan | null> {
  const names = Object.keys(deps).sort();
  if (names.length === 0) return null;
  const pkgPath = path.join(repoRoot, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${partName} requires npm packages (${names.join(", ")}) but there is no package.json at the repo root.`,
    );
  }
  const runtime = (pkg["dependencies"] ?? {}) as Record<string, string>;
  const dev = (pkg["devDependencies"] ?? {}) as Record<string, string>;
  const toAdd: Record<string, string> = {};
  const satisfied: string[] = [];
  const devOnly: string[] = [];
  for (const name of names) {
    const range = deps[name]!;
    const existing = runtime[name] ?? dev[name];
    if (existing === undefined) {
      toAdd[name] = range;
      continue;
    }
    let compatible: boolean;
    try {
      compatible = semver.intersects(existing, range);
    } catch {
      compatible = false; // git URLs, tags, workspace: ranges — humans decide
    }
    if (!compatible) {
      throw new Error(
        `${partName} requires ${name}@${range} but package.json already has ${name}@${existing} — ` +
          `version conflicts are yours to resolve; nothing was changed.`,
      );
    }
    satisfied.push(`${name}@${existing}`);
    if (runtime[name] === undefined) devOnly.push(name);
  }
  return { pkgPath, pkg, toAdd, satisfied, devOnly };
}

/** Never rewrites an existing entry — planNpmDependencies already vetted compatibility. */
export async function applyNpmDependencies(plan: NpmDepPlan): Promise<void> {
  const merged = {
    ...((plan.pkg["dependencies"] ?? {}) as Record<string, string>),
    ...plan.toAdd,
  };
  plan.pkg["dependencies"] = Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(plan.pkgPath, `${JSON.stringify(plan.pkg, null, 2)}\n`, "utf8");
}

/** Push the standard warnings a dep plan produces onto an op's warning list. */
export function depPlanWarnings(plan: NpmDepPlan | null): string[] {
  return (plan?.devOnly ?? []).map(
    (dep) =>
      `${dep} sits in devDependencies but the part needs it at runtime — move it to dependencies.`,
  );
}
