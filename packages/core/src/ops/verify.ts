import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { AttestationSchema } from "../attestation.js";
import { ContractSchema, effectiveNpmDependencies } from "../contract.js";
import { ATTESTATION_FILE, hashPartDir } from "../hash.js";
import { LOCKFILE_NAME, readLockfile } from "../lockfile.js";

export type FindingLevel = "fail" | "warn";

export interface Finding {
  level: FindingLevel;
  part: string;
  code:
    | "NO_LOCKFILE"
    | "UNTRACKED"
    | "MISSING"
    | "INTEGRITY"
    | "NO_ATTESTATION"
    | "ATTESTATION_MISMATCH"
    | "SIGNATURE_PIN"
    | "UNSIGNED"
    | "SIG_UNSUPPORTED"
    | "SIG_UNKNOWN"
    | "STALE"
    | "CONTRACT_INVALID"
    | "NPM_DEP_MISSING"
    | "NPM_DEP_RANGE"
    | "NPM_DEP_STALE";
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  findings: Finding[];
  checked: number;
}

/**
 * `partkit verify` per docs/01 FR4 — integrity and freshness are different
 * threats with different severities: signature/hash problems always fail;
 * staleness warns unless --strict. Our bad weekend must never redden a
 * stranger's CI; tampering always must.
 */
export async function verifyRepo(
  repoRoot: string,
  opts: { strict?: boolean; now?: Date } = {},
): Promise<VerifyResult> {
  const strict = opts.strict ?? false;
  const now = opts.now ?? new Date();
  const findings: Finding[] = [];

  const lf = await readLockfile(repoRoot);
  if (!lf) {
    return {
      ok: false,
      findings: [
        {
          level: "fail",
          part: "-",
          code: "NO_LOCKFILE",
          message: `No ${LOCKFILE_NAME} — run \`partkit init\` first.`,
        },
      ],
      checked: 0,
    };
  }

  const partsDir = path.join(repoRoot, "parts");
  let present: string[] = [];
  try {
    present = (await readdir(partsDir)).filter((n) => n !== ".DS_Store");
  } catch {
    present = [];
  }
  for (const name of present) {
    if (!lf.parts[name]) {
      findings.push({
        level: "fail",
        part: name,
        code: "UNTRACKED",
        message: `parts/${name} exists but is not in ${LOCKFILE_NAME} — remove it or install it via \`partkit add\`.`,
      });
    }
  }

  for (const [name, entry] of Object.entries(lf.parts)) {
    const dir = path.join(partsDir, name);
    try {
      await stat(dir);
    } catch {
      findings.push({
        level: "fail",
        part: name,
        code: "MISSING",
        message: `Locked but missing on disk: parts/${name}.`,
      });
      continue;
    }

    const hash = await hashPartDir(dir);
    if (hash !== entry.content_hash) {
      findings.push({
        level: "fail",
        part: name,
        code: "INTEGRITY",
        message: `Content hash mismatch — interiors were edited or corrupted. Locked ${entry.content_hash}, found ${hash}.`,
      });
      continue;
    }

    // npm_dependencies (RFC 0001 §2b): missing or out-of-range is an
    // integrity-class failure — the part cannot keep its claims. The
    // in-range-but-not-attested case is freshness-class and checked against
    // the attestation's npm: pins below.
    const installedDeps = new Map<string, string>();
    {
      let depRanges: Record<string, string> = {};
      try {
        const contractRaw = await readFile(path.join(dir, "contract.json"), "utf8");
        const parsed = ContractSchema.safeParse(JSON.parse(contractRaw));
        if (parsed.success) {
          depRanges = effectiveNpmDependencies(parsed.data, entry.adapter);
        } else {
          findings.push({
            level: "fail",
            part: name,
            code: "CONTRACT_INVALID",
            message: `contract.json does not validate (${parsed.error.issues[0]?.message ?? "schema error"}) — this CLI may predate the part's contract_version.`,
          });
        }
      } catch {
        findings.push({
          level: "fail",
          part: name,
          code: "CONTRACT_INVALID",
          message: "contract.json is missing or unreadable.",
        });
      }
      for (const [dep, range] of Object.entries(depRanges)) {
        let installed: string | null = null;
        try {
          const depPkg = JSON.parse(
            await readFile(path.join(repoRoot, "node_modules", dep, "package.json"), "utf8"),
          ) as { version?: unknown };
          installed = typeof depPkg.version === "string" ? depPkg.version : null;
        } catch {
          installed = null;
        }
        if (installed === null) {
          findings.push({
            level: "fail",
            part: name,
            code: "NPM_DEP_MISSING",
            message: `npm dependency ${dep}@${range} is not installed — run your package manager's install.`,
          });
        } else if (!semver.satisfies(installed, range)) {
          findings.push({
            level: "fail",
            part: name,
            code: "NPM_DEP_RANGE",
            message: `${dep}@${installed} is outside the contract range ${range} — the part's claims do not hold against it.`,
          });
        } else {
          installedDeps.set(dep, installed);
        }
      }
    }

    let attRaw: string;
    try {
      attRaw = await readFile(path.join(dir, ATTESTATION_FILE), "utf8");
    } catch {
      findings.push({
        level: "fail",
        part: name,
        code: "NO_ATTESTATION",
        message: `Missing ${ATTESTATION_FILE}.`,
      });
      continue;
    }
    const attParsed = AttestationSchema.safeParse(JSON.parse(attRaw));
    if (!attParsed.success) {
      findings.push({
        level: "fail",
        part: name,
        code: "NO_ATTESTATION",
        message: `Invalid ${ATTESTATION_FILE}: ${attParsed.error.issues[0]?.message ?? "schema error"}.`,
      });
      continue;
    }
    const att = attParsed.data;

    if (att.content_hash !== entry.content_hash) {
      findings.push({
        level: "fail",
        part: name,
        code: "ATTESTATION_MISMATCH",
        message: `Attestation signs ${att.content_hash}, lockfile pins ${entry.content_hash}.`,
      });
    }
    if (att.signature !== entry.attestation.signature) {
      findings.push({
        level: "fail",
        part: name,
        code: "SIGNATURE_PIN",
        message: "Attestation signature differs from the one pinned at install time.",
      });
    }

    if (att.signature.startsWith("dev:")) {
      findings.push({
        level: strict ? "fail" : "warn",
        part: name,
        code: "UNSIGNED",
        message: "Dev attestation (unsigned) — fine locally, not acceptable in production.",
      });
    } else if (att.signature.startsWith("sigstore:")) {
      // Fail closed: pretending to verify a signature would be worse than not having one.
      findings.push({
        level: "fail",
        part: name,
        code: "SIG_UNSUPPORTED",
        message: "Sigstore verification is not implemented yet — refusing to pretend it passed.",
      });
    } else {
      findings.push({
        level: "fail",
        part: name,
        code: "SIG_UNKNOWN",
        message: `Unknown signature scheme: "${att.signature.split(":")[0]}".`,
      });
    }

    for (const [dep, installed] of installedDeps) {
      const pinned = att.dependency_matrix[`npm:${dep}`];
      if (pinned !== undefined && pinned !== installed) {
        findings.push({
          level: strict ? "fail" : "warn",
          part: name,
          code: "NPM_DEP_STALE",
          message: `${dep}@${installed} is in the contract range but the attestation verified ${pinned} — freshness, not tampering.`,
        });
      }
    }

    if (new Date(att.expires).getTime() < now.getTime()) {
      findings.push({
        level: strict ? "fail" : "warn",
        part: name,
        code: "STALE",
        message: `Attestation expired ${att.expires} — a fresh one should exist in the registry (\`partkit upgrade\`), or the part failed re-verification.`,
      });
    }
  }

  const ok = !findings.some((f) => f.level === "fail");
  return { ok, findings, checked: Object.keys(lf.parts).length };
}
