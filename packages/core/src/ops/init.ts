import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOCKFILE_NAME, readLockfile, writeLockfile } from "../lockfile.js";
import {
  AGENTS_TEMPLATE,
  PARTS_START,
  CI_WORKFLOW,
  HOOK_MARKER,
  PRE_COMMIT_HOOK,
} from "../templates.js";

export interface InitOptions {
  registrySource: string;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  warnings: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs everything docs/03 §2 promises: lockfile, AGENTS.md, pre-commit
 * hook, CI boundary guard, and formatter ignores for parts/**. Idempotent.
 */
export async function initRepo(repoRoot: string, opts: InitOptions): Promise<InitResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  if (await readLockfile(repoRoot)) {
    skipped.push(LOCKFILE_NAME);
  } else {
    await writeLockfile(repoRoot, {
      lockfile_version: 1,
      registry: { source: opts.registrySource },
      parts: {},
    });
    created.push(LOCKFILE_NAME);
  }

  const agentsPath = path.join(repoRoot, "AGENTS.md");
  if (await exists(agentsPath)) {
    const cur = await readFile(agentsPath, "utf8");
    if (cur.includes(PARTS_START)) {
      skipped.push("AGENTS.md");
    } else {
      await writeFile(agentsPath, `${cur.trimEnd()}\n\n${AGENTS_TEMPLATE}`, "utf8");
      created.push("AGENTS.md (section appended)");
    }
  } else {
    await writeFile(agentsPath, AGENTS_TEMPLATE, "utf8");
    created.push("AGENTS.md");
  }

  // Pre-commit hook: the wall must exist at edit time, not only at PR time.
  const gitDir = path.join(repoRoot, ".git");
  if (await exists(gitDir)) {
    const hookPath = path.join(gitDir, "hooks", "pre-commit");
    if (await exists(hookPath)) {
      const cur = await readFile(hookPath, "utf8");
      if (cur.includes(HOOK_MARKER)) {
        skipped.push(".git/hooks/pre-commit");
      } else {
        warnings.push(
          "A pre-commit hook already exists. Add this line to it:\n    npx --no-install partkit guard --staged",
        );
      }
    } else {
      await mkdir(path.dirname(hookPath), { recursive: true });
      await writeFile(hookPath, PRE_COMMIT_HOOK, "utf8");
      await chmod(hookPath, 0o755);
      created.push(".git/hooks/pre-commit");
    }
  } else {
    warnings.push(
      "Not a git repository — pre-commit hook not installed. Run `git init`, then `partkit init` again.",
    );
  }

  const workflowPath = path.join(repoRoot, ".github", "workflows", "partkit.yml");
  if (await exists(workflowPath)) {
    skipped.push(".github/workflows/partkit.yml");
  } else {
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(workflowPath, CI_WORKFLOW, "utf8");
    created.push(".github/workflows/partkit.yml");
  }

  // Formatter ignore: a repo-wide `prettier --write` must not be able to
  // rewrite interiors and void lockfile hashes (docs/02 §7).
  const prettierIgnorePath = path.join(repoRoot, ".prettierignore");
  const ignoreLine = "parts/**";
  if (await exists(prettierIgnorePath)) {
    const cur = await readFile(prettierIgnorePath, "utf8");
    if (cur.split("\n").some((l) => l.trim() === ignoreLine)) {
      skipped.push(".prettierignore");
    } else {
      await writeFile(prettierIgnorePath, `${cur.trimEnd()}\n${ignoreLine}\n`, "utf8");
      created.push(".prettierignore (appended)");
    }
  } else {
    await writeFile(prettierIgnorePath, `${ignoreLine}\n`, "utf8");
    created.push(".prettierignore");
  }

  return { created, skipped, warnings };
}
