/**
 * Isolated conformance harness (docs/07 §5).
 *
 * Runs a part's strict-compile gate + conformance suite in a throwaway
 * workspace that contains ONLY the part's materialized tree and its DECLARED
 * npm_dependencies — never the monorepo's node_modules. This is the honest
 * attestation environment:
 *
 *   - A part cannot pass by leaning on a package that merely happens to be in
 *     the monorepo but is absent from its contract (undeclared-dependency
 *     reliance): if it is not declared, it is not installed, so the gate and
 *     the conformance suite fail loudly here instead of silently in a stranger's
 *     repo.
 *   - Wrapped-OSS parts (auth.session, jobs.queue, …) no longer need their
 *     libraries installed as root devDependencies. Many wrapped libraries with
 *     conflicting peer sets would otherwise have to coexist in one root install
 *     (auth.session already forced `--legacy-peer-deps`); in isolation each
 *     part's deps resolve alone.
 *
 * The version actually installed in the isolated workspace is what the
 * attestation pins (RFC 0001 §2c) — the pin and the tested bits are the same
 * bits by construction.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The runner toolchain installed alongside the part's declared deps. Pinned to
 * the monorepo's versions so isolated behavior matches `npm run check`. These
 * are the ONLY non-declared packages in the workspace — the part's own deps are
 * whatever its contract declares, nothing more.
 */
const RUNNER_DEV_DEPS = {
  vitest: "^3.0.0",
  typescript: "^5.6.0",
  "@types/node": "^22.10.0",
};

/**
 * The strict-compile gate (docs/02 §4). Identical flags to the in-repo path in
 * publish-part.mjs — the only difference is the cwd, so types resolve from the
 * isolated install. `--skipLibCheck` skips a dependency's shipped `.d.ts` only;
 * the part's own source is fully strict-checked.
 */
const GATE_FLAGS = [
  "--noEmit",
  "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
  "--noImplicitOverride", "--noFallthroughCasesInSwitch",
  "--skipLibCheck",
  "--target", "es2023", "--lib", "es2023",
  "--module", "preserve", "--moduleResolution", "bundler",
  "--types", "node",
];

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

function bin(ws, name) {
  return path.join(ws, "node_modules", ".bin", name);
}

/**
 * Which declared deps ship no usable type declarations in this install (own
 * `types`/`typings`, a root `index.d.ts`, or an installed `@types/<dep>`).
 * The attestation matrix pins runtime deps only (RFC 0001 — no types-only
 * packages), so DefinitelyTyped packages are never *pinned*; the harness still
 * installs them as build toolchain (alongside typescript/vitest) so the gate
 * type-checks against real types. A dep that is untyped AND has no @types
 * package on the registry (pg ships types via @types/pg, but some libraries
 * have neither) is genuinely opaque — the gate then treats it as `any`, and
 * conformance against the real library + real database proves correct usage.
 */
async function untypedDeps(ws, deps) {
  const out = [];
  for (const dep of deps) {
    const pkgDir = path.join(ws, "node_modules", dep);
    let typed = false;
    try {
      const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
      typed = Boolean(pkg.types || pkg.typings);
    } catch {
      /* unreadable — treat as opaque */
    }
    if (!typed) {
      try {
        await readFile(path.join(pkgDir, "index.d.ts"));
        typed = true;
      } catch {
        /* no root index.d.ts */
      }
    }
    if (!typed) {
      try {
        await readFile(path.join(ws, "node_modules", "@types", dep, "package.json"));
        typed = true;
      } catch {
        /* no DefinitelyTyped package installed (expected — matrix is runtime-only) */
      }
    }
    if (!typed) out.push(dep);
  }
  return out;
}

/**
 * Run one (part, adapter) through the isolated gate + conformance.
 *
 * @param {object} o
 * @param {string} o.materializedDir  the already-materialized tree for this adapter
 *   (src/, adapters/selected/, conformance/, migrations/ — what a consumer gets)
 * @param {Record<string,string>} o.effectiveDeps  declared deps for this adapter
 *   (effectiveNpmDependencies(contract, adapter): part-wide ∪ adapter)
 * @param {string} o.label  adapter label, for logs
 * @param {string[]} [o.installFlags]  extra npm install flags (e.g. --legacy-peer-deps)
 * @returns {Promise<{passed:number, pins:Record<string,string>, resultBuf:Buffer, workspaceDeps:string[]}>}
 */
export async function runIsolatedConformance({ materializedDir, effectiveDeps, label, installFlags = [] }) {
  const ws = await mkdtemp(path.join(tmpdir(), "partkit-conformance-"));
  try {
    // 1. The materialized tree IS the workspace content — exactly a consumer's
    // parts/<name>/ layout, so conformance's `../src/index` imports resolve unchanged.
    await cp(materializedDir, ws, { recursive: true });

    // Test-only deps (a DB part's pg driver to talk to a real database, say) are
    // distinct from the part's runtime npm_dependencies and must NOT be pinned in
    // the attestation. A part declares them in conformance/package.json; the
    // harness installs them as build toolchain alongside the runner.
    let conformanceDeps = {};
    try {
      const cpkg = JSON.parse(await readFile(path.join(ws, "conformance", "package.json"), "utf8"));
      conformanceDeps = { ...cpkg.dependencies, ...cpkg.devDependencies };
    } catch {
      /* none declared — fine for parts whose conformance needs only the runner */
    }

    // 2. The manifest: declared runtime deps + conformance test deps + the runner
    // toolchain, nothing else. Only the runtime deps are later pinned.
    const pkg = {
      name: "partkit-conformance-workspace",
      private: true,
      type: "module",
      dependencies: { ...effectiveDeps },
      devDependencies: { ...conformanceDeps, ...RUNNER_DEV_DEPS },
    };
    await writeFile(path.join(ws, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    await writeFile(
      path.join(ws, "vitest.config.ts"),
      'import { defineConfig } from "vitest/config";\n' +
        'export default defineConfig({ test: { include: ["conformance/**/*.test.ts"] } });\n',
    );

    // 3. Install — isolated node_modules with ONLY the declared deps + runner.
    const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", ...installFlags], {
      cwd: ws,
      stdio: "inherit",
      encoding: "utf8",
    });
    if (install.status !== 0) throw new Error(`isolated npm install failed (${label})`);

    // 4. Strict-compile gate, resolving types from the isolated install.
    const gateFiles = [];
    for (const sub of ["src", "adapters", "examples"]) {
      gateFiles.push(...(await collectTs(path.join(ws, sub))));
    }
    // For untyped runtime deps, install their DefinitelyTyped types as build
    // toolchain (not pinned in the matrix) so the gate checks real usage. Any
    // dep that has no @types package is declared opaque so the gate still runs.
    let untyped = await untypedDeps(ws, Object.keys(effectiveDeps));
    if (untyped.length) {
      const attempted = untyped;
      for (const dep of attempted) {
        spawnSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", `@types/${dep}`], {
          cwd: ws,
          stdio: "ignore", // tolerate a nonexistent @types package
        });
      }
      untyped = await untypedDeps(ws, Object.keys(effectiveDeps));
      const resolved = attempted.filter((d) => !untyped.includes(d));
      if (resolved.length) {
        console.log(`  ℹ installed types for the gate: ${resolved.map((d) => `@types/${d}`).join(", ")} (not pinned — RFC 0001)`);
      }
    }
    if (untyped.length) {
      const shim = path.join(ws, "_partkit_untyped.d.ts");
      const body = untyped.map((d) => `declare module "${d}";\ndeclare module "${d}/*";\n`).join("");
      await writeFile(shim, `// generated by the conformance harness — untyped runtime deps with no @types, treated as opaque\n${body}`);
      gateFiles.push(shim);
      console.log(`  ℹ opaque untyped runtime dep(s) for the gate: ${untyped.join(", ")} (no @types package; conformance exercises them for real)`);
    }
    const tsc = spawnSync(bin(ws, "tsc"), [...GATE_FLAGS, ...gateFiles], { cwd: ws, stdio: "inherit" });
    if (tsc.status !== 0) throw new Error(`strict-compile gate failed in isolation (${label})`);

    // 5. Conformance — the same suite a consumer could run, against only the
    // declared deps. Inherits env (PARTKIT_TEST_DATABASE_URL etc.).
    const resultsFile = path.join(ws, "results.json");
    const vitest = spawnSync(
      bin(ws, "vitest"),
      ["run", "--reporter=default", "--reporter=json", `--outputFile=${resultsFile}`],
      { cwd: ws, stdio: "inherit" },
    );
    if (vitest.status !== 0) throw new Error(`conformance failed in isolation (${label})`);
    const summary = JSON.parse(await readFile(resultsFile, "utf8"));
    const passed = summary.numPassedTests ?? 0;
    if (passed === 0) throw new Error("conformance ran zero tests in isolation — refusing to attest nothing");

    // 6. Honest pins: the versions actually installed and tested in the workspace.
    const pins = {};
    for (const dep of Object.keys(effectiveDeps)) {
      const installed = JSON.parse(
        await readFile(path.join(ws, "node_modules", dep, "package.json"), "utf8"),
      ).version;
      pins[`npm:${dep}`] = installed;
    }
    return { passed, pins, resultBuf: await readFile(resultsFile), workspaceDeps: Object.keys(effectiveDeps) };
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}
