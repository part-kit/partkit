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
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runIsolatedConformance } from "./conformance-harness.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Load conformance secrets from the repo's gitignored env files into process.env
 * (real exported vars always win; never overrides). Vendor-sandbox keys for
 * gated conformance (PARTKIT_TEST_DATABASE_URL, STRIPE_TEST_SECRET_KEY, …) live
 * in apps/web/.env.local or a root .env — both gitignored — so the part agent
 * doesn't have to juggle them by hand. Spawned conformance (isolated harness or
 * in-repo vitest) inherits process.env, so the keys reach the tests.
 */
for (const rel of [".env", "apps/web/.env.local"]) {
  let raw;
  try {
    raw = readFileSync(path.join(repoRoot, rel), "utf8");
  } catch {
    continue; // file absent — fine
  }
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // explicit env wins
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

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
// Conformance environment (docs/07 §5). A part that declares npm_dependencies
// (the OSS-wraps: auth.session, jobs.queue, …) is attested in an ISOLATED
// workspace by default — only its declared deps + the runner, never the
// monorepo's node_modules — so wrapped libraries never have to be root
// devDependencies. Zero-dep parts stay on the in-repo path (their published
// content is unchanged and their conformance test deps remain ambient).
//   --isolated     force isolation even for a zero-dep part
//   --in-repo      force the legacy monorepo path (local debugging)
const inRepo = process.argv.includes("--in-repo");
const forceIsolated = process.argv.includes("--isolated");
const legacyPeerDeps = process.argv.includes("--legacy-peer-deps");
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

  const effectiveDeps = effectiveNpmDependencies(contract, adapter);
  // Isolate when the part declares deps (or --isolated); --in-repo always wins.
  const useIsolated = !inRepo && (forceIsolated || Object.keys(effectiveDeps).length > 0);
  let passed;
  let npmPins;
  let resultBuf;

  if (!useIsolated) {
    // Legacy fast path (local debugging only): gate + conformance against the
    // monorepo's node_modules. Never the attestation path in CI — see --in-repo.
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
        "--skipLibCheck",
        "--target", "es2023", "--lib", "es2023",
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
    console.log("  ✔ strict-compile gate (in-repo)");

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
    passed = (JSON.parse(await readFile(resultsFile, "utf8")).numPassedTests) ?? 0;
    if (passed === 0) {
      console.error("✖ conformance ran zero tests — refusing to attest nothing");
      process.exit(1);
    }
    resultBuf = await readFile(resultsFile);
    npmPins = {};
    for (const [dep, range] of Object.entries(effectiveDeps)) {
      let installed = null;
      try {
        installed = JSON.parse(
          await readFile(path.join(repoRoot, "node_modules", dep, "package.json"), "utf8"),
        ).version ?? null;
      } catch {
        installed = null;
      }
      if (installed === null) {
        console.error(`✖ declared npm dependency ${dep}@${range} is not installed in the monorepo`);
        process.exit(1);
      }
      npmPins[`npm:${dep}`] = installed;
    }
    console.log(`  ✔ conformance: ${passed} tests passed`);
  } else {
    // Default: the honest isolated environment (docs/07 §5). Gate + conformance
    // run in a throwaway workspace with ONLY the declared deps installed; the
    // pins are the versions actually installed and tested there.
    try {
      const r = await runIsolatedConformance({
        materializedDir: workDir,
        effectiveDeps,
        label,
        installFlags: legacyPeerDeps ? ["--legacy-peer-deps"] : [],
      });
      passed = r.passed;
      npmPins = r.pins;
      resultBuf = r.resultBuf;
      const depList = r.workspaceDeps.length ? r.workspaceDeps.join(", ") : "none (zero-dep part)";
      console.log(`  ✔ isolated conformance: ${passed} tests passed · deps: ${depList}`);
    } catch (e) {
      console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
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
      result_hash: `sha256:${createHash("sha256").update(resultBuf).digest("hex")}`,
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
