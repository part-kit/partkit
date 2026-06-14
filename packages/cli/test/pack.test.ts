import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  StaticRegistry,
  addParts,
  hashPartDir,
  initRepo,
  materializePart,
  parseAddTarget,
  readLockfile,
} from "@part-kit/core";
import { makeTempDir } from "./helpers";

interface PartSpec {
  name: string;
  provides?: string[]; // default [`${name}@1`]; multiple → a multi-capability part
  requires?: string[]; // e.g. "testing.base>=1"
  adapters: { name: string; status: "attested" | "community" }[]; // [] → adapterless
}

/** Build a multi-part fixture registry (+ packs) with correctly-hashed dev attestations. */
async function makeMultiRegistry(root: string, parts: PartSpec[], packs: Record<string, unknown>): Promise<string> {
  const reg = path.join(root, "registry");
  const version = "1.0.0";
  const index: { registry_version: 1; parts: Record<string, { latest: string; versions: string[]; provides: string[] }> } = {
    registry_version: 1,
    parts: {},
  };

  for (const spec of parts) {
    const partDir = path.join(reg, "parts", spec.name, version, "part");
    await mkdir(path.join(partDir, "src", "internal"), { recursive: true });
    await mkdir(path.join(reg, "parts", spec.name, version, "attestations"), { recursive: true });
    const provides = spec.provides ?? [`${spec.name}@1`];
    const contract = {
      part: spec.name,
      version,
      contract_version: "0.1",
      provides,
      requires: spec.requires ?? [],
      platform: { node: ">=22" },
      adapters: spec.adapters.map((a) => ({ name: a.name, vendor_api: "v1", status: a.status })),
      interface: { exports: ["run(): void"], events: [], http_routes: [] },
      env: {},
      invariants: ["does the thing"],
      license: "MIT",
    };
    await writeFile(path.join(partDir, "contract.json"), JSON.stringify(contract, null, 2));
    await writeFile(path.join(partDir, "src", "index.ts"), `export function run(): void {}\n`);
    await writeFile(path.join(partDir, "src", "internal", "impl.ts"), `export const I = true;\n`);
    await writeFile(path.join(partDir, "seams.md"), `# ${spec.name}\n\nCall run().\n`);
    for (const a of spec.adapters) {
      await mkdir(path.join(partDir, "adapters", a.name), { recursive: true });
      await writeFile(path.join(partDir, "adapters", a.name, "adapter.ts"), `export const name = "${a.name}";\n`);
    }
    // Adapterless parts attest as `default` (adapter: null); others per adapter.
    const attestAs: (string | null)[] = spec.adapters.length > 0 ? spec.adapters.map((a) => a.name) : [null];
    for (const aName of attestAs) {
      const work = path.join(root, `.work-${spec.name}-${aName ?? "default"}`);
      await materializePart(partDir, aName, work);
      const content_hash = await hashPartDir(work);
      const attestation = {
        part: spec.name,
        version,
        adapter: aName,
        content_hash,
        verified_at: new Date().toISOString(),
        dependency_matrix: { node: "22.x" },
        conformance_run: "local:test-fixture",
        tests_passed: 1,
        result_hash: `sha256:${"0".repeat(64)}`,
        signature: "dev:unsigned",
        expires: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      };
      await writeFile(
        path.join(reg, "parts", spec.name, version, "attestations", `${aName ?? "default"}.json`),
        JSON.stringify(attestation, null, 2),
      );
    }
    index.parts[spec.name] = { latest: version, versions: [version], provides };
  }

  await writeFile(path.join(reg, "index.json"), JSON.stringify(index, null, 2));
  await mkdir(path.join(reg, "packs"), { recursive: true });
  for (const [name, body] of Object.entries(packs)) {
    await writeFile(path.join(reg, "packs", `${name}.json`), JSON.stringify(body, null, 2));
  }
  return reg;
}

const PARTS: PartSpec[] = [
  { name: "testing.base", adapters: [{ name: "x", status: "attested" }] },
  { name: "testing.dep", requires: ["testing.base>=1"], adapters: [{ name: "x", status: "attested" }] },
  {
    name: "testing.dual",
    adapters: [
      { name: "p", status: "attested" },
      { name: "q", status: "attested" },
    ],
  },
  // Multi-capability part: provides both testing.multi@1 AND testing.alias@1.
  {
    name: "testing.multi",
    provides: ["testing.multi@1", "testing.alias@1"],
    adapters: [
      { name: "m1", status: "attested" },
      { name: "m2", status: "attested" },
    ],
  },
  // Adapterless part (like auth.session / storage.upload).
  { name: "testing.bare", adapters: [] },
];

const PACKS = {
  kit: {
    pack: "kit",
    title: "Test Kit",
    summary: "dep + dual",
    capabilities: ["testing.dep", "testing.dual"],
    adapters: { "testing.dual": "q" },
  },
  broken: {
    pack: "broken",
    title: "Broken Kit",
    summary: "names a part that doesn't exist",
    capabilities: ["testing.base", "testing.ghost"],
  },
};

describe("parseAddTarget", () => {
  it("parses name, version, adapter", () => {
    expect(parseAddTarget("email.transactional")).toEqual({ name: "email.transactional" });
    expect(parseAddTarget("email.transactional:postmark")).toEqual({ name: "email.transactional", adapter: "postmark" });
    expect(parseAddTarget("billing.subscription@1.0.0:stripe")).toEqual({
      name: "billing.subscription",
      version: "1.0.0",
      adapter: "stripe",
    });
    expect(parseAddTarget("saas")).toEqual({ name: "saas" });
  });
  it("rejects malformed targets", () => {
    expect(() => parseAddTarget("a:b:c")).toThrow(/at most one/);
    expect(() => parseAddTarget("a:")).toThrow(/empty adapter/);
    expect(() => parseAddTarget(":x")).toThrow(/missing part/);
    expect(() => parseAddTarget("a@")).toThrow(/empty version/);
  });
});

describe("registry.pack()", () => {
  let reg: string;
  beforeAll(async () => {
    reg = await makeMultiRegistry(await makeTempDir("pk-pack-reg-"), PARTS, PACKS);
  });
  it("loads a pack, returns null for an unknown one, rejects bad names", async () => {
    const r = await StaticRegistry.open(reg);
    const kit = await r.pack("kit");
    expect(kit?.capabilities).toEqual(["testing.dep", "testing.dual"]);
    expect(kit?.adapters).toEqual({ "testing.dual": "q" });
    expect(await r.pack("nope")).toBeNull();
    await expect(r.pack("../etc")).rejects.toThrow(/Invalid pack name/);
  });
});

describe("addParts: packs, multi-target, requires, adapters", () => {
  async function freshRepo(): Promise<{ repo: string; reg: string }> {
    const root = await makeTempDir("pk-pack-");
    const reg = await makeMultiRegistry(root, PARTS, PACKS);
    const repo = path.join(root, "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: reg });
    return { repo, reg };
  }

  it("installs a pack: pulls requires, orders them, applies the pack's adapter default", async () => {
    const { repo } = await freshRepo();
    const res = await addParts(repo, { targets: ["kit"] });

    expect(res.packs.map((p) => p.pack)).toEqual(["kit"]);
    const order = res.installed.map((r) => r.name);
    // testing.base is a requirement of testing.dep — must come first; testing.dual rides along.
    expect(order).toContain("testing.base");
    expect(order.indexOf("testing.base")).toBeLessThan(order.indexOf("testing.dep"));
    expect(order).toContain("testing.dual");
    // pack default picked adapter q for the ambiguous part
    expect(res.installed.find((r) => r.name === "testing.dual")?.adapter).toBe("q");

    const lf = await readLockfile(repo);
    expect(Object.keys(lf?.parts ?? {}).sort()).toEqual(["testing.base", "testing.dep", "testing.dual"]);
  });

  it("is idempotent: re-adding what's installed reports already-satisfied, installs nothing", async () => {
    const { repo } = await freshRepo();
    await addParts(repo, { targets: ["kit"] });
    const again = await addParts(repo, { targets: ["testing.base", "testing.dual"] });
    expect(again.installed).toHaveLength(0);
    expect(again.alreadySatisfied.map((s) => s.capability).sort()).toEqual(["testing.base", "testing.dual"]);
  });

  it("multi-target with an inline adapter override", async () => {
    const { repo } = await freshRepo();
    const res = await addParts(repo, { targets: ["testing.base", "testing.dual:p"] });
    expect(res.installed.find((r) => r.name === "testing.dual")?.adapter).toBe("p");
  });

  it("fails clean (nothing installed) when an adapter is ambiguous and unspecified", async () => {
    const { repo } = await freshRepo();
    await expect(addParts(repo, { targets: ["testing.dual"] })).rejects.toThrow(/needs an adapter/);
    const lf = await readLockfile(repo);
    expect(Object.keys(lf?.parts ?? {})).toHaveLength(0);
  });

  it("rejects an adapter on a pack target", async () => {
    const { repo } = await freshRepo();
    await expect(addParts(repo, { targets: ["kit:p"] })).rejects.toThrow(/is a pack/);
  });

  it("reports a roadmap-honest error for a pack naming an unshipped capability", async () => {
    const { repo } = await freshRepo();
    await expect(addParts(repo, { targets: ["broken"] })).rejects.toThrow(/not installable yet/);
    const lf = await readLockfile(repo);
    expect(Object.keys(lf?.parts ?? {})).toHaveLength(0);
  });

  // Regression: override maps must key by resolved part, not the typed capability.
  it("honors a version + adapter override addressed by a part's SECONDARY capability", async () => {
    const { repo } = await freshRepo();
    const res = await addParts(repo, { targets: ["testing.alias@1.0.0:m2"] });
    const multi = res.installed.find((r) => r.name === "testing.multi");
    expect(multi?.adapter).toBe("m2"); // adapter override reached addPart via the alias
    expect(multi?.version).toBe("1.0.0"); // version pin reached addPart via the alias
  });

  it("a bogus version via a secondary capability reaches validation (fails clean)", async () => {
    const { repo } = await freshRepo();
    await expect(addParts(repo, { targets: ["testing.alias@9.9.9:m1"] })).rejects.toThrow(/not in the registry/);
    expect(Object.keys((await readLockfile(repo))?.parts ?? {})).toHaveLength(0);
  });

  // Regression: override adapters are validated in pre-flight (zero installed on bad input).
  it("rejects an unknown override adapter before installing anything", async () => {
    const { repo } = await freshRepo();
    await expect(addParts(repo, { targets: ["testing.base", "testing.multi:nope"] })).rejects.toThrow(/no adapter "nope"/);
    expect(Object.keys((await readLockfile(repo))?.parts ?? {})).toHaveLength(0);
  });

  it("rejects an adapter on an adapterless part; installs it cleanly without one", async () => {
    const { repo } = await freshRepo();
    await expect(addParts(repo, { targets: ["testing.bare:x"] })).rejects.toThrow(/takes no adapter/);
    const res = await addParts(repo, { targets: ["testing.bare"] });
    expect(res.installed.find((r) => r.name === "testing.bare")?.adapter).toBeNull();
  });
});
