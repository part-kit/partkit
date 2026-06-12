import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addPart, guardRepo, initRepo, readLockfile, verifyRepo } from "@part-kit/core";
import { makeFixtureRegistry, makeTempDir } from "./helpers";

describe("the walkthrough, mechanized: init → add → verify → tamper → guard", () => {
  let repo: string;
  let registry: string;

  beforeAll(async () => {
    const root = await makeTempDir("partkit-e2e-");
    registry = await makeFixtureRegistry(root);
    repo = path.join(root, "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);

    const res = await initRepo(repo, { registrySource: registry });
    expect(res.created).toContain("parts.lock");
    expect(res.created).toContain("AGENTS.md");
    expect(res.created).toContain(".git/hooks/pre-commit");
    expect(res.created).toContain(".prettierignore");
  });

  it("init is idempotent", async () => {
    const again = await initRepo(repo, { registrySource: registry });
    expect(again.created).toEqual([]);
    expect(again.skipped).toContain("parts.lock");
  });

  it("adds a part: vendors the selected adapter only, pins the lockfile, scaffolds env, updates AGENTS.md", async () => {
    const res = await addPart(repo, { name: "testing.echo", adapter: "alpha" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBe("alpha");

    const lf = await readLockfile(repo);
    expect(lf?.parts["testing.echo"]?.adapter).toBe("alpha");
    expect(lf?.parts["testing.echo"]?.content_hash).toBe(res.contentHash);

    // non-selected adapter pruned
    await expect(
      readFile(path.join(repo, "parts/testing.echo/adapters/beta/adapter.ts"), "utf8"),
    ).rejects.toThrow();
    // selected adapter flattened to adapters/selected/
    const alpha = await readFile(
      path.join(repo, "parts/testing.echo/adapters/selected/adapter.ts"),
      "utf8",
    );
    expect(alpha).toContain("alpha");

    // env scaffold prefills enum keys that include the chosen adapter
    const env = await readFile(path.join(repo, ".env.example"), "utf8");
    expect(env).toContain("ECHO_ADAPTER=alpha");
    expect(env).toContain("ECHO_SECRET=");

    // AGENTS.md installed list updated
    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("testing.echo@1.0.0");
  });

  it("refuses a second provider of the same capability (anti-sprawl) and double-installs", async () => {
    await expect(addPart(repo, { name: "testing.echo", adapter: "alpha" })).rejects.toThrow(
      /already installed/,
    );
  });

  it("community adapters need explicit opt-in", async () => {
    // fresh repo so anti-sprawl doesn't trip first
    const root = await makeTempDir("partkit-community-");
    const repo2 = path.join(root, "app");
    await mkdir(repo2, { recursive: true });
    await initRepo(repo2, { registrySource: registry });

    await expect(addPart(repo2, { name: "testing.echo", adapter: "beta" })).rejects.toThrow(
      /--allow-community/,
    );
    const res = await addPart(repo2, {
      name: "testing.echo",
      adapter: "beta",
      allowCommunity: true,
    });
    expect(res.adapter).toBe("beta");
  });

  it("verify is green, with the dev-signature warning (integrity ok, scheme unsigned)", async () => {
    const res = await verifyRepo(repo);
    expect(res.ok).toBe(true);
    expect(res.checked).toBe(1);
    expect(res.findings.map((f) => f.code)).toContain("UNSIGNED");
    expect(res.findings.every((f) => f.level === "warn")).toBe(true);
  });

  it("strict mode fails on the unsigned dev attestation", async () => {
    const res = await verifyRepo(repo, { strict: true });
    expect(res.ok).toBe(false);
  });

  it("guard is the wall: tampering with an interior fails guard and verify, restoring heals both", async () => {
    const target = path.join(repo, "parts/testing.echo/src/index.ts");
    const original = await readFile(target, "utf8");
    await writeFile(target, `${original}// malicious edit\n`);

    const guard = await guardRepo(repo);
    expect(guard.ok).toBe(false);
    expect(guard.problems.some((p) => p.includes("was modified"))).toBe(true);

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(false);
    expect(ver.findings.some((f) => f.code === "INTEGRITY")).toBe(true);

    await writeFile(target, original);
    expect((await guardRepo(repo)).ok).toBe(true);
  });

  it("an untracked directory under parts/ fails guard and verify", async () => {
    const rogue = path.join(repo, "parts", "rogue.part");
    await mkdir(rogue, { recursive: true });
    await writeFile(path.join(rogue, "x.ts"), "export {};\n");

    const guard = await guardRepo(repo);
    expect(guard.ok).toBe(false);

    const ver = await verifyRepo(repo);
    expect(ver.findings.some((f) => f.code === "UNTRACKED")).toBe(true);

    execFileSync("rm", ["-rf", rogue]);
    expect((await guardRepo(repo)).ok).toBe(true);
  });

  it("staleness warns by default and fails only under --strict (docs/01 FR4)", async () => {
    const future = new Date(Date.now() + 30 * 86_400_000);
    const res = await verifyRepo(repo, { now: future });
    expect(res.ok).toBe(true);
    expect(res.findings.some((f) => f.code === "STALE" && f.level === "warn")).toBe(true);

    const strict = await verifyRepo(repo, { now: future, strict: true });
    expect(strict.ok).toBe(false);
  });
});
