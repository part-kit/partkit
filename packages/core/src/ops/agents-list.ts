import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Lockfile } from "../lockfile.js";
import { PARTS_END, PARTS_START } from "../templates.js";

/**
 * Keep AGENTS.md's installed-parts list current — the in-repo half of
 * anti-sprawl: agents see what exists without an MCP round-trip. Shared by
 * add / upgrade / eject. Returns a warning instead of throwing when the
 * managed block is missing — list maintenance must never fail the operation.
 */
export async function syncInstalledParts(
  repoRoot: string,
  lf: Lockfile,
): Promise<string | null> {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  let agents: string;
  try {
    agents = await readFile(agentsPath, "utf8");
  } catch {
    return "AGENTS.md is missing or unmanaged — run `partkit init` to restore it.";
  }
  if (!agents.includes(PARTS_START) || !agents.includes(PARTS_END)) {
    return "AGENTS.md is missing or unmanaged — run `partkit init` to restore it.";
  }
  const items = Object.entries(lf.parts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, e]) =>
        `- \`${name}@${e.version}\`${e.adapter !== null ? ` (adapter: ${e.adapter})` : ""} — seams: \`parts/${name}/seams.md\``,
    )
    .join("\n");
  const body = items === "" ? "(none yet)" : items;
  const start = agents.indexOf(PARTS_START) + PARTS_START.length;
  const end = agents.indexOf(PARTS_END);
  await writeFile(agentsPath, `${agents.slice(0, start)}\n${body}\n${agents.slice(end)}`, "utf8");
  return null;
}
