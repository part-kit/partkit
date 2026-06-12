#!/usr/bin/env node
/**
 * Mirror ../../registry into public/registry so the deployment serves the
 * static registry itself — registry.partkit.dev is a host rewrite onto this
 * path (vercel.json). One deploy = site + registry, always in sync.
 */
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const mirrors = [
  [path.join(repo, "registry"), path.join(here, "..", "public", "registry")],
  [path.join(repo, "skills"), path.join(here, "..", "public", "skills")],
];

for (const [src, dest] of mirrors) {
  try {
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest, { recursive: true });
    console.log(`✔ mirrored ${src} → ${path.relative(path.join(here, ".."), dest)}`);
  } catch (e) {
    console.error(`✖ mirror failed: src=${src} cwd=${process.cwd()} — ${e.message}`);
    process.exit(1);
  }
}
