import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addPart, initRepo, verifyRepo } from "@part-kit/core";
import { makeFixtureRegistry, makeTempDir, type FixtureOptions } from "./helpers";

const DEP = "demo-wrapped-lib";

async function makeApp(
  fixture: FixtureOptions,
  pkg: Record<string, unknown> | null = { name: "app", private: true },
): Promise<string> {
  const root = await makeTempDir("partkit-npmdeps-");
  const registry = await makeFixtureRegistry(root, fixture);
  const repo = path.join(root, "app");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  if (pkg !== null) {
    await writeFile(path.join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  }
  await initRepo(repo, { registrySource: registry });
  return repo;
}

async function readPkg(repo: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
}

/** Simulate an installed package so verify can read its version. */
async function installFake(repo: string, name: string, version: string): Promise<void> {
  const dir = path.join(repo, "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version }));
}

describe("npm_dependencies (RFC 0001): partkit add", () => {
  it("merges part-wide ∪ selected-adapter deps into package.json dependencies", async () => {
    const repo = await makeApp({
      npmDependencies: { [DEP]: "^1.3.0" },
      alphaNpmDependencies: { "demo-alpha-sdk": "^2.0.0" },
    });
    const res = await addPart(repo, { name: "testing.echo", adapter: "alpha" });

    expect(res.npmDependencies.added).toEqual({
      [DEP]: "^1.3.0",
      "demo-alpha-sdk": "^2.0.0",
    });
    const pkg = await readPkg(repo);
    expect(pkg["dependencies"]).toEqual({ "demo-alpha-sdk": "^2.0.0", [DEP]: "^1.3.0" });
  });

  it("hard-fails on a version conflict without touching anything", async () => {
    const repo = await makeApp(
      { npmDependencies: { [DEP]: "^1.3.0" } },
      { name: "app", dependencies: { [DEP]: "~1.1.0" } },
    );
    const before = await readPkg(repo);
    await expect(addPart(repo, { name: "testing.echo", adapter: "alpha" })).rejects.toThrow(
      /version conflicts are yours/,
    );
    expect(await readPkg(repo)).toEqual(before);
    // nothing vendored, nothing locked
    await expect(readFile(path.join(repo, "parts/testing.echo/contract.json"))).rejects.toThrow();
    expect(await readFile(path.join(repo, "parts.lock"), "utf8")).not.toContain("testing.echo");
  });

  it("leaves a satisfying existing entry untouched and reports it", async () => {
    const repo = await makeApp(
      { npmDependencies: { [DEP]: "^1.3.0" } },
      { name: "app", dependencies: { [DEP]: "^1.4.2" } },
    );
    const res = await addPart(repo, { name: "testing.echo", adapter: "alpha" });
    expect(res.npmDependencies.added).toEqual({});
    expect(res.npmDependencies.satisfied).toEqual([`${DEP}@^1.4.2`]);
    expect((await readPkg(repo))["dependencies"]).toEqual({ [DEP]: "^1.4.2" });
  });

  it("warns when the dep only exists in devDependencies", async () => {
    const repo = await makeApp(
      { npmDependencies: { [DEP]: "^1.3.0" } },
      { name: "app", devDependencies: { [DEP]: "^1.4.0" } },
    );
    const res = await addPart(repo, { name: "testing.echo", adapter: "alpha" });
    expect(res.warnings.some((w) => w.includes("devDependencies"))).toBe(true);
  });

  it("fails when deps are declared but the app has no package.json", async () => {
    const repo = await makeApp({ npmDependencies: { [DEP]: "^1.3.0" } }, null);
    await expect(addPart(repo, { name: "testing.echo", adapter: "alpha" })).rejects.toThrow(
      /no package\.json/,
    );
  });
});

describe("npm_dependencies (RFC 0001): partkit verify", () => {
  async function appWithPart(attestationPins?: Record<string, string>): Promise<string> {
    const repo = await makeApp({
      npmDependencies: { [DEP]: "^1.3.0" },
      ...(attestationPins !== undefined && { attestationPins }),
    });
    await addPart(repo, { name: "testing.echo", adapter: "alpha" });
    return repo;
  }

  it("missing dep fails", async () => {
    const repo = await appWithPart();
    const res = await verifyRepo(repo);
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === "NPM_DEP_MISSING" && f.level === "fail")).toBe(true);
  });

  it("out-of-range dep fails", async () => {
    const repo = await appWithPart();
    await installFake(repo, DEP, "2.0.0");
    const res = await verifyRepo(repo);
    expect(res.findings.some((f) => f.code === "NPM_DEP_RANGE" && f.level === "fail")).toBe(true);
  });

  it("in-range matching the attested pin is clean; in-range but unattested warns, --strict fails", async () => {
    const pinned = await appWithPart({ [`npm:${DEP}`]: "1.5.0" });
    await installFake(pinned, DEP, "1.5.0");
    const clean = await verifyRepo(pinned);
    expect(clean.findings.filter((f) => f.code.startsWith("NPM_DEP"))).toEqual([]);

    await installFake(pinned, DEP, "1.6.0");
    const drifted = await verifyRepo(pinned);
    const stale = drifted.findings.find((f) => f.code === "NPM_DEP_STALE");
    expect(stale?.level).toBe("warn");
    expect(drifted.ok).toBe(true); // freshness never reddens CI by default

    const strict = await verifyRepo(pinned, { strict: true });
    expect(strict.findings.find((f) => f.code === "NPM_DEP_STALE")?.level).toBe("fail");
  });
});
