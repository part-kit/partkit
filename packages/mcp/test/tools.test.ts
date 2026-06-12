import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NO_EDIT_RULE, StaticRegistry, resolvePlan } from "@part-kit/core";
import { makeFixtureRegistry, makeTempDir } from "../../cli/test/helpers";
import {
  getAttestation,
  getContract,
  getSeams,
  getUpgradePlan,
  searchParts,
} from "../src/tools.js";

/** The repo's own registry — three real shipped parts. */
const REAL_REGISTRY = fileURLToPath(new URL("../../../registry", import.meta.url));

/** Minimal registry where testing.beta requires testing.alpha — exercises ordering. */
async function makeRequiresRegistry(): Promise<string> {
  const root = await makeTempDir("partkit-resolve-");
  const reg = path.join(root, "registry");
  const write = async (part: string, contract: object) => {
    const dir = path.join(reg, "parts", part, "1.0.0", "part");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "contract.json"), JSON.stringify(contract));
  };
  await write("testing.alpha", {
    part: "testing.alpha",
    version: "1.0.0",
    contract_version: "0.1",
    provides: ["testing.alpha@1"],
    platform: { node: ">=22" },
    interface: { exports: ["alpha(): void"] },
    env: { ALPHA_KEY: { required: true, secret: true } },
    license: "MIT",
  });
  await write("testing.beta", {
    part: "testing.beta",
    version: "1.0.0",
    contract_version: "0.1",
    provides: ["testing.beta@1"],
    requires: ["testing.alpha>=1"],
    interface: {
      exports: ["beta(): void"],
      http_routes: [{ route: "POST /api/beta", export: "betaHandler" }],
    },
    data_ownership: { tables: ["testing_beta_events"], writes_only_own_tables: true },
    license: "MIT",
  });
  await writeFile(
    path.join(reg, "index.json"),
    JSON.stringify({
      registry_version: 1,
      parts: {
        "testing.alpha": { latest: "1.0.0", versions: ["1.0.0"], provides: ["testing.alpha@1"] },
        "testing.beta": { latest: "1.0.0", versions: ["1.0.0"], provides: ["testing.beta@1"] },
      },
    }),
  );
  return reg;
}

describe("resolver (docs/03 §4)", () => {
  it("orders requires-first, reports env/migrations/seams, and the no-edit rule travels with the plan", async () => {
    const registry = await StaticRegistry.open(await makeRequiresRegistry());
    const plan = await resolvePlan(registry, { capabilities: ["testing.beta"] });

    expect(plan.install_order.map((e) => e.part)).toEqual(["testing.alpha", "testing.beta"]);
    expect(plan.install_order[0]!.reason).toBe("required by testing.beta");
    expect(plan.install_order[1]!.reason).toBe("requested");
    expect(plan.env_required).toEqual(["ALPHA_KEY"]);
    expect(plan.migrations).toContain("1 part(s) own tables");
    expect(plan.seams_to_write[1]).toContain("mount POST /api/beta");
    expect(plan.rules).toEqual([NO_EDIT_RULE]);
  });

  it("anti-sprawl: an installed provider satisfies the capability and is never reinstalled", async () => {
    const registry = await StaticRegistry.open(await makeRequiresRegistry());
    const plan = await resolvePlan(registry, {
      capabilities: ["testing.beta"],
      lockfile: {
        parts: { "testing.alpha": { version: "1.0.0", provides: ["testing.alpha@1"] } },
      },
    });
    expect(plan.install_order.map((e) => e.part)).toEqual(["testing.beta"]);
    expect(plan.already_satisfied).toEqual([
      { capability: "testing.alpha", part: "testing.alpha", version: "1.0.0" },
    ]);
  });

  it("fails loudly on unknown capabilities and platform conflicts", async () => {
    const registry = await StaticRegistry.open(await makeRequiresRegistry());
    await expect(resolvePlan(registry, { capabilities: ["jobs.queue"] })).rejects.toThrow(
      /No part provides .* testing.alpha, testing.beta/s,
    );
    await expect(
      resolvePlan(registry, {
        capabilities: ["testing.alpha"],
        constraints: { node: "20" },
      }),
    ).rejects.toThrow(/platform conflict/);
  });

  it("trust policy: attested-only picks the single attested adapter; allow-community demands a choice", async () => {
    const root = await makeTempDir("partkit-trust-");
    const registry = await StaticRegistry.open(await makeFixtureRegistry(root));

    const attested = await resolvePlan(registry, { capabilities: ["testing.echo"] });
    expect(attested.install_order[0]!.adapter).toBe("alpha");

    const open = await resolvePlan(registry, {
      capabilities: ["testing.echo"],
      policy: { trust: "allow-community" },
    });
    expect(open.install_order[0]!.adapter).toBeNull();
    expect(open.install_order[0]!.adapter_choices).toEqual(["alpha", "beta"]);
    expect(open.notes.some((n) => n.includes("--adapter=alpha|beta"))).toBe(true);
  });

  it("is deterministic: same inputs → same plan_id; different lockfile → different plan_id", async () => {
    const registry = await StaticRegistry.open(await makeRequiresRegistry());
    const a = await resolvePlan(registry, { capabilities: ["testing.beta"] });
    const b = await resolvePlan(registry, { capabilities: ["testing.beta"] });
    expect(a.plan_id).toBe(b.plan_id);
    expect(a.plan_id).toMatch(/^sha256:[0-9a-f]{64}$/);

    const c = await resolvePlan(registry, {
      capabilities: ["testing.beta"],
      lockfile: { parts: { "testing.alpha": { version: "1.0.0", provides: ["testing.alpha@1"] } } },
    });
    expect(c.plan_id).not.toBe(a.plan_id);
  });
});

describe("MCP tools against the real registry", () => {
  it("search_parts: empty query lists the catalog; substring narrows it", async () => {
    const registry = await StaticRegistry.open(REAL_REGISTRY);
    const all = await searchParts(registry, "");
    expect(all.count).toBeGreaterThanOrEqual(3);
    expect(all.parts.map((p) => p.part)).toContain("email.transactional");

    const hit = await searchParts(registry, "webhook");
    expect(hit.parts.map((p) => p.part)).toContain("webhooks.ingest");
    const wh = hit.parts.find((p) => p.part === "webhooks.ingest")!;
    expect(wh.adapters.map((a) => a.name).sort()).toEqual(["standardwebhooks", "stripe"]);
    expect(wh.summary).toBeTruthy();
  });

  it("resolve_plan composes the three shipped parts deterministically", async () => {
    const registry = await StaticRegistry.open(REAL_REGISTRY);
    const plan = await resolvePlan(registry, {
      capabilities: ["email.transactional", "webhooks.ingest", "ratelimit.api"],
      constraints: { node: "22" },
    });
    expect(plan.install_order.map((e) => e.part)).toEqual([
      "email.transactional",
      "ratelimit.api",
      "webhooks.ingest",
    ]);
    // email + webhooks each have two attested adapters → explicit choice
    expect(plan.install_order[0]!.adapter_choices).toEqual(["postmark", "resend"]);
    expect(plan.install_order[2]!.adapter_choices).toEqual(["standardwebhooks", "stripe"]);
    // ratelimit is the zero-adapter, zero-env precedent
    expect(plan.install_order[1]!.adapter).toBeNull();
    expect(plan.install_order[1]!.adapter_choices).toBeUndefined();
    expect(plan.env_required).toContain("WEBHOOK_SECRET");
    expect(plan.migrations).toBe("no part-owned tables in this plan");
  });

  it("get_contract / get_seams / get_attestation / get_upgrade_plan", async () => {
    const registry = await StaticRegistry.open(REAL_REGISTRY);

    const contract = await getContract(registry, "ratelimit.api");
    expect(contract.version).toBe("1.0.1");
    await expect(getContract(registry, "no.such")).rejects.toThrow(/Available:/);

    const seams = await getSeams(registry, "webhooks.ingest");
    expect(seams.seams.length).toBeGreaterThan(200);

    const att = await getAttestation(registry, "email.transactional", undefined, "resend");
    expect(att.fresh).toBe(true);
    const expired = await getAttestation(
      registry,
      "email.transactional",
      undefined,
      "resend",
      new Date("2099-01-01"),
    );
    expect(expired.fresh).toBe(false);
    expect(expired.note).toContain("never hard-fails");

    const up = await getUpgradePlan(registry, "ratelimit.api", "1.0.0", "1.0.0");
    expect(up.available).toBe(false);
    expect(up.reason).toContain("already at");
  });
});
