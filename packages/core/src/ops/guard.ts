import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { hashPartDir } from "../hash.js";
import { LOCKFILE_NAME, readLockfile, type Lockfile } from "../lockfile.js";

export interface GuardResult {
  ok: boolean;
  problems: string[];
}

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "parts",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
]);
/** import|export … from "x", require("x"), import("x") */
const SPECIFIER_RE =
  /(?:from\s*|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/g;

/**
 * The legal import surface is parts/<name>/src/index — everything else under
 * parts/** is interior (docs/02 §8). Bypassing index.ts couples the app to
 * internals that upgrades may rewrite, and reading internal/ is how agents
 * end up depending on what the attestation never promised.
 */
function importViolation(specifier: string): string | null {
  // Only app-side specifiers can point into parts/: relative paths and the
  // common app aliases. Bare npm packages that merely contain "parts/" in
  // their path are not ours to police.
  const isAppPath =
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/") ||
    specifier.startsWith("parts/");
  if (!isAppPath) return null;
  const idx = specifier.search(/(?:^|\/)parts\//);
  if (idx === -1) return null;
  const inside = specifier.slice(specifier.indexOf("parts/", idx) + "parts/".length);
  const [, ...rest] = inside.split("/");
  const tail = rest.join("/").replace(/\.(?:js|ts|mjs|cjs|jsx|tsx)$/, "");
  if (tail === "src/index") return null;
  return tail === ""
    ? `imports the part directory itself — import parts/<name>/src/index instead`
    : `imports part interior "${tail}" — only parts/<name>/src/index is the legal surface (docs/02 §8)`;
}

/**
 * App-side source files (everything outside parts/, node_modules, and build
 * output), each with its repo-relative path. Shared by the import-boundary
 * scan and by `audit`'s route/sprawl checks so all three see the same files.
 */
export async function appSourceFiles(
  repoRoot: string,
): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name), rel === "" ? e.name : `${rel}/${e.name}`);
      } else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name))) {
        const file = rel === "" ? e.name : `${rel}/${e.name}`;
        out.push({ file, text: await readFile(path.join(dir, e.name), "utf8") });
      }
    }
  };
  await walk(repoRoot, "");
  return out;
}

/** Specifiers an app file imports — the regex used to police the boundary. */
export function importSpecifiers(text: string): string[] {
  const specs: string[] = [];
  for (const m of text.matchAll(SPECIFIER_RE)) specs.push(m[1]!);
  return specs;
}

/** App code may import only each part's index (docs/02 §8). */
export async function importBoundaryProblems(repoRoot: string): Promise<string[]> {
  const problems: string[] = [];
  for (const { file, text } of await appSourceFiles(repoRoot)) {
    for (const spec of importSpecifiers(text)) {
      const violation = importViolation(spec);
      if (violation !== null) problems.push(`${file}: ${violation} (saw "${spec}")`);
    }
  }
  return problems;
}

/**
 * The hash/tracking half of the boundary: parts/** must match parts.lock.
 * Takes the already-read lockfile so callers that need it elsewhere (audit)
 * don't read it twice.
 */
export async function boundaryHashProblems(
  repoRoot: string,
  lf: Lockfile | null,
): Promise<string[]> {
  const problems: string[] = [];
  const partsDir = path.join(repoRoot, "parts");

  let present: string[] = [];
  try {
    present = (await readdir(partsDir)).filter((n) => n !== ".DS_Store");
  } catch {
    present = [];
  }

  if (!lf) {
    if (present.length > 0) {
      problems.push(`parts/ exists but there is no ${LOCKFILE_NAME} — run \`partkit init\`.`);
    }
    return problems;
  }

  for (const name of present) {
    if (!lf.parts[name]) problems.push(`parts/${name} is not in ${LOCKFILE_NAME}.`);
  }

  for (const [name, entry] of Object.entries(lf.parts)) {
    const dir = path.join(partsDir, name);
    try {
      await stat(dir);
    } catch {
      problems.push(`parts/${name} is locked but missing on disk.`);
      continue;
    }
    const hash = await hashPartDir(dir);
    if (hash !== entry.content_hash) {
      problems.push(`parts/${name} was modified (content hash no longer matches ${LOCKFILE_NAME}).`);
    }
  }

  return problems;
}

/**
 * The boundary guard — the control against ACCIDENT (docs/03 §8): a
 * state-based comparison of parts/** against parts.lock. No attestation or
 * freshness logic here; that is `verify`'s job (the control against malice).
 */
export async function guardRepo(repoRoot: string): Promise<GuardResult> {
  const lf = await readLockfile(repoRoot);
  const problems = await boundaryHashProblems(repoRoot, lf);

  // Without a lockfile there is nothing to bound the imports against — match
  // the original behaviour and stop at the tracking problem.
  if (!lf) return { ok: problems.length === 0, problems };

  // The other half of the boundary (docs/02 §8): app code may import only
  // each part's index. Edits are caught by hashes above; bypasses here — both
  // run in the pre-commit hook and CI.
  problems.push(...(await importBoundaryProblems(repoRoot)));

  return { ok: problems.length === 0, problems };
}
