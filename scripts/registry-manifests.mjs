#!/usr/bin/env node
/**
 * Generate parts/<name>/<version>/manifest.json for every published part —
 * the file list an HTTP client needs, since a static registry cannot list
 * directories. Per-file sha256 lets the client verify each download before
 * the attestation's content-hash check seals the materialized tree.
 *
 * Idempotent; run standalone (backfill) or via registry:publish.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const partsRoot = path.join(repoRoot, "registry", "parts");

async function walk(root, rel = "") {
  const out = [];
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
    if (e.name === ".DS_Store") continue;
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(root, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

export async function writeManifest(partName, version) {
  const versionDir = path.join(partsRoot, partName, version);
  const contentDir = path.join(versionDir, "part");
  const files = [];
  for (const rel of (await walk(contentDir)).sort()) {
    const bytes = await readFile(path.join(contentDir, rel));
    files.push({
      path: rel,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
  let attestations = [];
  try {
    attestations = (await readdir(path.join(versionDir, "attestations")))
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/, ""))
      .sort();
  } catch {
    attestations = [];
  }
  const manifest = { manifest_version: 1, part: partName, version, files, attestations };
  await writeFile(
    path.join(versionDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let count = 0;
  for (const name of (await readdir(partsRoot)).filter((n) => n !== ".DS_Store").sort()) {
    for (const version of (await readdir(path.join(partsRoot, name))).filter((n) => n !== ".DS_Store").sort()) {
      const m = await writeManifest(name, version);
      console.log(`✔ ${name}@${version}: ${m.files.length} files, ${m.attestations.length} attestation(s)`);
      count += 1;
    }
  }
  console.log(`${count} manifest(s) written`);
}
