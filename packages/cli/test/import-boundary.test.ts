import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addPart, guardRepo, initRepo } from "@part-kit/core";
import { makeFixtureRegistry, makeTempDir } from "./helpers";

async function makeApp(): Promise<string> {
  const root = await makeTempDir("partkit-imports-");
  const registry = await makeFixtureRegistry(root);
  const repo = path.join(root, "app");
  await mkdir(path.join(repo, "lib"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  await initRepo(repo, { registrySource: registry });
  await addPart(repo, { name: "testing.echo", adapter: "alpha" });
  return repo;
}

describe("guard: the import surface (docs/02 §8)", () => {
  it("accepts index imports in every common shape", async () => {
    const repo = await makeApp();
    await writeFile(
      path.join(repo, "lib", "ok.ts"),
      `import { echo } from "../parts/testing.echo/src/index";
import { echo as e2 } from "@/parts/testing.echo/src/index.js";
const dynamic = await import("../parts/testing.echo/src/index");
import notOurs from "some-lib/parts/internal/whatever"; // bare npm pkg — not ours to police
`,
    );
    const res = await guardRepo(repo);
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("rejects interior, adapter, and bare-directory imports with the file named", async () => {
    const repo = await makeApp();
    await writeFile(
      path.join(repo, "lib", "bad.ts"),
      `import { INTERNAL } from "../parts/testing.echo/src/internal/impl";
import { adapter } from "@/parts/testing.echo/adapters/selected/adapter";
const lazy = require("parts/testing.echo/src/internal/impl");
import whole from "../parts/testing.echo";
`,
    );
    const res = await guardRepo(repo);
    expect(res.ok).toBe(false);
    const text = res.problems.join("\n");
    expect(res.problems).toHaveLength(4);
    expect(text).toContain("lib/bad.ts");
    expect(text).toContain('src/internal/impl');
    expect(text).toContain("adapters/selected/adapter");
    expect(text).toContain("only parts/<name>/src/index is the legal surface");
  });

  it("never scans inside parts/ itself — interiors import each other freely", async () => {
    const repo = await makeApp();
    // the vendored part's own files import ./internal/* — must not be flagged
    const res = await guardRepo(repo);
    expect(res.ok).toBe(true);
  });
});
