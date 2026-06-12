import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPartDir, materializePart } from "@part-kit/core";

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export interface FixtureOptions {
  /** Part-wide npm_dependencies (forces contract_version 0.2 — RFC 0001). */
  npmDependencies?: Record<string, string>;
  /** npm_dependencies on the alpha adapter only. */
  alphaNpmDependencies?: Record<string, string>;
  /** Extra dependency_matrix pins for the dev attestations (e.g. "npm:x": "1.5.0"). */
  attestationPins?: Record<string, string>;
}

/**
 * Builds a minimal but spec-complete fixture registry with one part
 * (testing.echo@1.0.0, adapters alpha=attested / beta=community) and dev
 * attestations whose content hashes are computed the same way `partkit add`
 * verifies them.
 */
export async function makeFixtureRegistry(
  root: string,
  opts: FixtureOptions = {},
): Promise<string> {
  const reg = path.join(root, "registry");
  const name = "testing.echo";
  const version = "1.0.0";
  const partDir = path.join(reg, "parts", name, version, "part");

  await mkdir(path.join(partDir, "src", "internal"), { recursive: true });
  await mkdir(path.join(partDir, "adapters", "alpha"), { recursive: true });
  await mkdir(path.join(partDir, "adapters", "beta"), { recursive: true });
  await mkdir(path.join(reg, "parts", name, version, "attestations"), { recursive: true });

  const hasDeps = opts.npmDependencies !== undefined || opts.alphaNpmDependencies !== undefined;
  const contract = {
    part: name,
    version,
    contract_version: hasDeps ? "0.2" : "0.1",
    provides: ["testing.echo@1"],
    requires: [],
    platform: { node: ">=22" },
    ...(opts.npmDependencies !== undefined && { npm_dependencies: opts.npmDependencies }),
    adapters: [
      {
        name: "alpha",
        vendor_api: "v1",
        status: "attested",
        ...(opts.alphaNpmDependencies !== undefined && {
          npm_dependencies: opts.alphaNpmDependencies,
        }),
      },
      { name: "beta", vendor_api: "v1", status: "community" },
    ],
    interface: { exports: ["echo(message): string"], events: [], http_routes: [] },
    env: {
      ECHO_ADAPTER: { required: true, enum: ["alpha", "beta"] },
      ECHO_SECRET: { required: true, secret: true },
    },
    invariants: ["echo returns its input"],
    license: "MIT",
  };

  await writeFile(path.join(partDir, "contract.json"), JSON.stringify(contract, null, 2));
  await writeFile(path.join(partDir, "src", "index.ts"), `export function echo(m: string): string {\n  return m;\n}\n`);
  await writeFile(path.join(partDir, "src", "internal", "impl.ts"), `export const INTERNAL = true;\n`);
  await writeFile(path.join(partDir, "adapters", "alpha", "adapter.ts"), `export const name = "alpha";\n`);
  await writeFile(path.join(partDir, "adapters", "beta", "adapter.ts"), `export const name = "beta";\n`);
  await writeFile(path.join(partDir, "seams.md"), `# Seams\n\nNothing to implement; call \`echo()\` from app code.\n`);

  for (const adapter of ["alpha", "beta"]) {
    // Hash exactly what `partkit add` will produce: a materialized tree.
    const work = path.join(root, `.work-${adapter}`);
    await materializePart(partDir, adapter, work);
    const content_hash = await hashPartDir(work);
    const attestation = {
      part: name,
      version,
      adapter,
      content_hash,
      verified_at: new Date().toISOString(),
      dependency_matrix: { node: "22.x", ...(opts.attestationPins ?? {}) },
      conformance_run: "local:test-fixture",
      tests_passed: 1,
      result_hash: `sha256:${"0".repeat(64)}`,
      signature: "dev:unsigned",
      expires: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    };
    await writeFile(
      path.join(reg, "parts", name, version, "attestations", `${adapter}.json`),
      JSON.stringify(attestation, null, 2),
    );
  }

  const index = {
    registry_version: 1,
    parts: {
      [name]: { latest: version, versions: [version], provides: ["testing.echo@1"] },
    },
  };
  await writeFile(path.join(reg, "index.json"), JSON.stringify(index, null, 2));
  return reg;
}
