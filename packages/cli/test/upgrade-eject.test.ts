import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addPart,
  ejectPart,
  guardRepo,
  initRepo,
  readLockfile,
  upgradePart,
  verifyRepo,
} from "@part-kit/core";
import { makeFixtureRegistry, makeTempDir, type FixtureOptions } from "./helpers";

const REAL_REGISTRY = fileURLToPath(new URL("../../../registry", import.meta.url));

async function makeApp(fixture: FixtureOptions = {}, registrySource?: string): Promise<string> {
  const root = await makeTempDir("partkit-upg-");
  const registry = registrySource ?? (await makeFixtureRegistry(root, fixture));
  const repo = path.join(root, "app");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "app" }, null, 2)}\n`);
  await initRepo(repo, { registrySource: registry });
  return repo;
}

describe("partkit upgrade", () => {
  it("flips the adapter: lockfile, adapters/selected, env prefill — and verify stays green", async () => {
    const repo = await makeApp();
    await addPart(repo, { name: "testing.echo", adapter: "alpha" });

    const res = await upgradePart(repo, {
      name: "testing.echo",
      adapter: "beta",
      allowCommunity: true,
    });
    expect(res.changed).toBe(true);
    expect(res.from.adapter).toBe("alpha");
    expect(res.to.adapter).toBe("beta");
    expect(res.seamChanges).toBeNull(); // same version: the contract didn't move

    const lf = await readLockfile(repo);
    expect(lf?.parts["testing.echo"]?.adapter).toBe("beta");
    expect(lf?.parts["testing.echo"]?.content_hash).toBe(res.contentHash);

    const selected = await readFile(
      path.join(repo, "parts/testing.echo/adapters/selected/adapter.ts"),
      "utf8",
    );
    expect(selected).toContain("beta");

    const env = await readFile(path.join(repo, ".env.example"), "utf8");
    expect(env).toContain("ECHO_ADAPTER=beta");
    expect(env).not.toContain("ECHO_ADAPTER=alpha");

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("(adapter: beta)");

    expect((await verifyRepo(repo)).ok).toBe(true);
    expect((await guardRepo(repo)).ok).toBe(true);
  });

  it("is a no-op at the same version and adapter", async () => {
    const repo = await makeApp();
    await addPart(repo, { name: "testing.echo", adapter: "alpha" });
    const res = await upgradePart(repo, { name: "testing.echo" });
    expect(res.changed).toBe(false);
    expect(res.warnings[0]).toContain("already at");
  });

  it("enforces the trust policy and rejects unknown adapters, not installed, unknown versions", async () => {
    const repo = await makeApp();
    await addPart(repo, { name: "testing.echo", adapter: "alpha" });

    await expect(upgradePart(repo, { name: "testing.echo", adapter: "beta" })).rejects.toThrow(
      /community-tier/,
    );
    await expect(upgradePart(repo, { name: "testing.echo", adapter: "gamma" })).rejects.toThrow(
      /no adapter "gamma"/,
    );
    await expect(upgradePart(repo, { name: "testing.echo", version: "9.9.9" })).rejects.toThrow(
      /no version 9\.9\.9/,
    );
    await expect(upgradePart(repo, { name: "no.such" })).rejects.toThrow(/not installed/);
  });

  it("reports adapter-specific npm deps that became obsolete, never auto-removing them", async () => {
    const repo = await makeApp({ alphaNpmDependencies: { "demo-alpha-sdk": "^2.0.0" } });
    await addPart(repo, { name: "testing.echo", adapter: "alpha" });
    const pkgBefore = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
    expect(pkgBefore.dependencies).toEqual({ "demo-alpha-sdk": "^2.0.0" });

    const res = await upgradePart(repo, {
      name: "testing.echo",
      adapter: "beta",
      allowCommunity: true,
    });
    expect(res.npmDependencies.obsolete).toEqual(["demo-alpha-sdk"]);
    expect(res.warnings.some((w) => w.includes("no longer needed"))).toBe(true);
    const pkgAfter = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
    expect(pkgAfter.dependencies).toEqual({ "demo-alpha-sdk": "^2.0.0" }); // untouched
  });

  it("THE FLIP on the real registry: resend → postmark is lockfile + selected adapter + one env line", async () => {
    const repo = await makeApp({}, REAL_REGISTRY);
    await addPart(repo, { name: "email.transactional", adapter: "resend" });
    const envBefore = await readFile(path.join(repo, ".env.example"), "utf8");
    expect(envBefore).toContain("EMAIL_ADAPTER=resend");

    const res = await upgradePart(repo, { name: "email.transactional", adapter: "postmark" });
    expect(res.changed).toBe(true);
    expect(res.seamChanges).toBeNull();

    const env = await readFile(path.join(repo, ".env.example"), "utf8");
    expect(env).toContain("EMAIL_ADAPTER=postmark");
    const selected = await readFile(
      path.join(repo, "parts/email.transactional/adapters/selected/adapter.ts"),
      "utf8",
    );
    expect(selected.toLowerCase()).toContain("postmark");
    expect((await verifyRepo(repo)).ok).toBe(true);
    expect((await guardRepo(repo)).ok).toBe(true);
  });
});

describe("partkit eject", () => {
  it("moves the part out of the boundary, voids the attestation, and the repo stays green", async () => {
    const repo = await makeApp();
    await addPart(repo, { name: "testing.echo", adapter: "alpha" });

    const res = await ejectPart(repo, { name: "testing.echo" });
    expect(res.to).toBe(path.join("ejected", "testing.echo"));

    await expect(stat(path.join(repo, "parts/testing.echo"))).rejects.toThrow();
    await stat(path.join(repo, "ejected/testing.echo/src/index.ts"));
    await expect(
      stat(path.join(repo, "ejected/testing.echo/ATTESTATION.json")),
    ).rejects.toThrow();

    const lf = await readLockfile(repo);
    expect(lf?.parts["testing.echo"]).toBeUndefined();
    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("(none yet)");
    expect(res.warnings.some((w) => w.includes("You own"))).toBe(true);

    expect((await verifyRepo(repo)).ok).toBe(true);
    expect((await guardRepo(repo)).ok).toBe(true);

    // ejection frees the capability — a provider can be installed again
    const again = await addPart(repo, { name: "testing.echo", adapter: "alpha" });
    expect(again.version).toBe("1.0.0");
  });

  it("refuses destinations outside the repo or under parts/, and unknown parts", async () => {
    const repo = await makeApp();
    await addPart(repo, { name: "testing.echo", adapter: "alpha" });
    await expect(ejectPart(repo, { name: "testing.echo", to: "../escape" })).rejects.toThrow(
      /inside the repo/,
    );
    await expect(
      ejectPart(repo, { name: "testing.echo", to: "parts/other" }),
    ).rejects.toThrow(/cannot be under parts\//);
    await expect(ejectPart(repo, { name: "no.such" })).rejects.toThrow(/not installed/);
  });
});
