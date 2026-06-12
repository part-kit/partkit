#!/usr/bin/env node
/**
 * Registry-side publisher — the local embryo of the verification CI (docs/03 §5).
 *
 * For each attested/community adapter (or an explicit --adapters list):
 *   materialize → strict-compile gate → conformance suite → issue dev attestation
 * then update registry/index.json.
 *
 * Usage:
 *   npm run build
 *   node scripts/publish-part.mjs --part email.transactional --version 1.0.0
 *     --check               validate + gate + conformance only; write nothing
 *     --adapters a,b        restrict to specific adapters
 *     --expires-days 14     attestation lifetime (docs/02 §5)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let core;
try {
  core = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
} catch {
  console.error("✖ @part-kit/core is not built — run `npm run build` first.");
  process.exit(1);
}
const { ContractSchema, effectiveNpmDependencies, hashPartDir, materializePart } = core;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const checkOnly = process.argv.includes("--check");
const partName = arg("part");
const version = arg("version");
if (!partName || !version) {
  console.error(
    "usage: publish-part.mjs --part <name> --version <x.y.z> [--adapters a,b] [--expires-days N] [--check]",
  );
  process.exit(1);
}

const contentDir = path.join(repoRoot, "registry", "parts", partName, version, "part");
const contract = ContractSchema.parse(
  JSON.parse(await readFile(path.join(contentDir, "contract.json"), "utf8")),
);
if (contract.part !== partName || contract.version !== version) {
  console.error(
    `✖ contract.json declares ${contract.part}@${contract.version}, expected ${partName}@${version}`,
  );
  process.exit(1);
}
console.log(`✔ contract.json validates (${contract.provides.join(", ")})`);

const adapterArg = arg("adapters");
const adapterNames = adapterArg
  ? adapterArg.split(",")
  : contract.adapters.filter((a) => a.status !== "experimental").map((a) => a.name);
const targets = adapterNames.length > 0 ? adapterNames : [null];

const expiresDays = Number(arg("expires-days", "14"));
// In GitHub Actions the attestation records the public run URL — anyone can
// click through to the green conformance log (docs/03 §5). Locally it stays
// honest about being local.
const conformanceRun =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "local:scripts/publish-part.mjs";
const workRoot = path.join(repoRoot, ".partkit-work");
const workDir = path.join(workRoot, "current");
const issued = [];

async function collectTs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collectTs(p)));
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

for (const adapter of targets) {
  const label = adapter ?? "default";
  console.log(`\n── ${partName}@${version} · adapter: ${label}`);
  await materializePart(contentDir, adapter, workDir);

  // 1. The strict-compile gate (docs/02 §4): src + adapters + examples must
  // compile under the strictest mainstream tsconfig.
  const gateFiles = [];
  for (const sub of ["src", "adapters", "examples"]) {
    gateFiles.push(...(await collectTs(path.join(workDir, sub))));
  }
  const tsc = spawnSync(
    "npx",
    [
      "tsc", "--noEmit",
      "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
      "--noImplicitOverride", "--noFallthroughCasesInSwitch",
      // skipLibCheck is part of every strictest-mainstream tsconfig (@tsconfig/
      // strictest, Next's default, and our own tsconfig.base.json): a part cannot
      // fix bugs inside a dependency's shipped .d.ts, and no consumer type-checks
      // them. Without it the gate type-checks better-auth's CryptoKey/bun:sqlite
      // declarations and is stricter than anything real. It still fully checks
      // the part's OWN .ts source. (First exposed by auth.session, the first
      // OSS-wrapping part; the five zero-dep parts never reached a third-party .d.ts.)
      "--skipLibCheck",
      "--target", "es2023", "--lib", "es2023",
      // Bundler resolution: parts are vendored TS consumed by the app's
      // bundler (Next/Turbopack/Vite), so imports are extensionless — the
      // shape every mainstream consumer resolves (issue #1: Turbopack has no
      // .js→.ts extension alias and broke every fresh Next 16 repo).
      "--module", "preserve", "--moduleResolution", "bundler",
      "--types", "node",
      ...gateFiles,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (tsc.status !== 0) {
    console.error(`✖ strict-compile gate failed (${label})`);
    process.exit(1);
  }
  console.log("  ✔ strict-compile gate");

  // 2. Conformance — the same suite for every adapter, against the
  // materialized tree (adapters/selected/), exactly as a consumer gets it.
  const resultsFile = path.join(workRoot, "results.json");
  const vitest = spawnSync(
    "npx",
    [
      "vitest", "run",
      "--config", "vitest.conformance.config.ts",
      "--reporter=default", "--reporter=json", `--outputFile=${resultsFile}`,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (vitest.status !== 0) {
    console.error(`✖ conformance failed (${label})`);
    process.exit(1);
  }
  const summary = JSON.parse(await readFile(resultsFile, "utf8"));
  const passed = summary.numPassedTests ?? 0;
  if (passed === 0) {
    console.error("✖ conformance ran zero tests — refusing to attest nothing");
    process.exit(1);
  }
  console.log(`  ✔ conformance: ${passed} tests passed`);

  // 3. Issue the attestation over the materialized content hash. Declared
  // npm dependencies are pinned at the exact version conformance ran against
  // (RFC 0001 §2c) — if one is absent from the monorepo, conformance cannot
  // have exercised it, so refuse to attest.
  const npmPins = {};
  for (const [dep, range] of Object.entries(effectiveNpmDependencies(contract, adapter))) {
    let installed = null;
    try {
      installed =
        JSON.parse(await readFile(path.join(repoRoot, "node_modules", dep, "package.json"), "utf8"))
          .version ?? null;
    } catch {
      installed = null;
    }
    if (installed === null) {
      console.error(
        `✖ declared npm dependency ${dep}@${range} is not installed in the monorepo — refusing to attest what conformance never ran against`,
      );
      process.exit(1);
    }
    npmPins[`npm:${dep}`] = installed;
  }
  const contentHash = await hashPartDir(workDir);
  issued.push({
    adapter,
    attestation: {
      part: partName,
      version,
      adapter,
      content_hash: contentHash,
      verified_at: new Date().toISOString(),
      dependency_matrix: { node: process.versions.node, ...npmPins },
      conformance_run: conformanceRun,
      tests_passed: passed,
      result_hash: `sha256:${createHash("sha256").update(await readFile(resultsFile)).digest("hex")}`,
      signature: "dev:unsigned",
      expires: new Date(Date.now() + expiresDays * 86_400_000).toISOString(),
    },
  });
  await rm(workDir, { recursive: true, force: true });
}

if (checkOnly) {
  console.log(`\n✔ --check passed for ${partName}@${version} (nothing written)`);
  process.exit(0);
}

const attDir = path.join(repoRoot, "registry", "parts", partName, version, "attestations");
await mkdir(attDir, { recursive: true });
for (const { adapter, attestation } of issued) {
  const file = path.join(attDir, `${adapter ?? "default"}.json`);
  await writeFile(file, `${JSON.stringify(attestation, null, 2)}\n`);
  console.log(`  + ${path.relative(repoRoot, file)}`);
}

function semverCompare(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

const { writeManifest } = await import(new URL("./registry-manifests.mjs", import.meta.url).href);
const manifest = await writeManifest(partName, version);
console.log(`  + manifest.json (${manifest.files.length} files)`);

const indexPath = path.join(repoRoot, "registry", "index.json");
const index = JSON.parse(await readFile(indexPath, "utf8"));
const entry = index.parts[partName] ?? { latest: version, versions: [], provides: contract.provides };
if (!entry.versions.includes(version)) entry.versions.push(version);
entry.versions.sort(semverCompare);
entry.latest = entry.versions[entry.versions.length - 1];
entry.provides = contract.provides;
index.parts[partName] = entry;
await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

console.log(
  `\n✔ published ${partName}@${version}: ${issued.length} attestation(s), registry/index.json updated`,
);
