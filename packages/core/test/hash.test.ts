import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashPartDir, materializePart } from "@part-kit/core";

async function makePartDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "partkit-hash-"));
  await mkdir(path.join(dir, "src", "internal"), { recursive: true });
  await mkdir(path.join(dir, "adapters", "alpha"), { recursive: true });
  await mkdir(path.join(dir, "adapters", "beta"), { recursive: true });
  await writeFile(path.join(dir, "contract.json"), `{"a":1}`);
  await writeFile(path.join(dir, "src", "index.ts"), `export const x = 1;`);
  await writeFile(path.join(dir, "src", "internal", "y.ts"), `export const y = 2;`);
  await writeFile(path.join(dir, "adapters", "alpha", "a.ts"), `export const a = "alpha";`);
  await writeFile(path.join(dir, "adapters", "beta", "b.ts"), `export const b = "beta";`);
  return dir;
}

describe("hashPartDir", () => {
  it("is deterministic and content-sensitive", async () => {
    const dir = await makePartDir();
    const h1 = await hashPartDir(dir);
    const h2 = await hashPartDir(dir);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);

    await writeFile(path.join(dir, "src", "index.ts"), `export const x = 999;`);
    expect(await hashPartDir(dir)).not.toBe(h1);
  });

  it("excludes ATTESTATION.json (the attestation signs the hash, so it cannot be part of it)", async () => {
    const dir = await makePartDir();
    const before = await hashPartDir(dir);
    await writeFile(path.join(dir, "ATTESTATION.json"), `{"signature":"dev:unsigned"}`);
    expect(await hashPartDir(dir)).toBe(before);
  });

  it("materialize flattens the selected adapter and is independent of sibling adapters", async () => {
    const dir = await makePartDir();
    const out1 = path.join(dir, "..", "partkit-mat-1");
    await materializePart(dir, "alpha", out1);

    // flattened layout: selected adapter lives at adapters/selected/
    const flattened = await readFile(path.join(out1, "adapters", "selected", "a.ts"), "utf8");
    expect(flattened).toContain("alpha");
    await expect(
      readFile(path.join(out1, "adapters", "beta", "b.ts"), "utf8"),
    ).rejects.toThrow();

    // changing a NON-selected adapter must not change the materialized hash
    const h1 = await hashPartDir(out1);
    await writeFile(path.join(dir, "adapters", "beta", "b.ts"), `export const b = "changed";`);
    const out2 = path.join(dir, "..", "partkit-mat-2");
    await materializePart(dir, "alpha", out2);
    expect(await hashPartDir(out2)).toBe(h1);
  });

  it("materialize fails loudly on a missing adapter", async () => {
    const dir = await makePartDir();
    await expect(
      materializePart(dir, "nope", path.join(dir, "..", "partkit-mat-3")),
    ).rejects.toThrow(/not found/);
  });
});
