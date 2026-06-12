import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROVIDES_RE, SEMVER_RE } from "./contract.js";

export const LOCKFILE_NAME = "parts.lock";

export const LockfileEntrySchema = z.object({
  version: z.string().regex(SEMVER_RE),
  adapter: z.string().nullable(),
  provides: z.array(z.string().regex(PROVIDES_RE)).min(1),
  content_hash: z.string(),
  attestation: z.object({
    verified_at: z.string(),
    expires: z.string(),
    signature: z.string(),
    result_hash: z.string(),
  }),
  provenance: z.string(),
});
export type LockfileEntry = z.infer<typeof LockfileEntrySchema>;

export const LockfileSchema = z.object({
  lockfile_version: z.literal(1),
  registry: z.object({ source: z.string() }),
  parts: z.record(LockfileEntrySchema),
});
export type Lockfile = z.infer<typeof LockfileSchema>;

export function lockfilePath(repoRoot: string): string {
  return path.join(repoRoot, LOCKFILE_NAME);
}

export async function readLockfile(repoRoot: string): Promise<Lockfile | null> {
  let raw: string;
  try {
    raw = await readFile(lockfilePath(repoRoot), "utf8");
  } catch {
    return null;
  }
  return LockfileSchema.parse(JSON.parse(raw));
}

/** Stable output: sorted part keys, 2-space indent, trailing newline — lockfiles are diffed by humans and agents. */
export async function writeLockfile(repoRoot: string, lf: Lockfile): Promise<void> {
  const ordered: Lockfile = {
    lockfile_version: lf.lockfile_version,
    registry: lf.registry,
    parts: Object.fromEntries(
      Object.entries(lf.parts).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  await writeFile(lockfilePath(repoRoot), `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}
