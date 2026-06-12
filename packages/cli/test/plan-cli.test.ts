import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeFixtureRegistry, makeTempDir } from "./helpers";

/**
 * The first test that exercises the BUILT BINARY (dist/cli.js) — option
 * wiring slipped through once already (--part-version read as blockVersion);
 * core-level tests cannot catch that class.
 */
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe("partkit plan (binary)", () => {
  it("prints a JSON plan against a registry", async () => {
    const root = await makeTempDir("partkit-plan-");
    const registry = await makeFixtureRegistry(root);
    const out = execFileSync(
      "node",
      [CLI, "plan", "testing.echo", "--registry", registry, "--json"],
      { encoding: "utf8" },
    );
    const plan = JSON.parse(out);
    expect(plan.install_order).toMatchObject([{ part: "testing.echo", adapter: "alpha" }]);
    expect(plan.plan_id).toMatch(/^sha256:/);
    expect(plan.rules[0]).toContain("Do not edit parts/**");
  });

  it("fails loudly on unknown capabilities", async () => {
    const root = await makeTempDir("partkit-plan-");
    const registry = await makeFixtureRegistry(root);
    expect(() =>
      execFileSync("node", [CLI, "plan", "no.such", "--registry", registry], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow(/No part provides/);
  });
});
