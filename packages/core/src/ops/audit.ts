import { readFile } from "node:fs/promises";
import path from "node:path";
import { capabilityOf, ContractSchema, type Contract } from "../contract.js";
import { LOCKFILE_NAME, readLockfile } from "../lockfile.js";
import {
  appSourceFiles,
  boundaryHashProblems,
  importBoundaryProblems,
  importSpecifiers,
} from "./guard.js";
import { verifyRepo } from "./verify.js";

export type AuditLevel = "pass" | "warn" | "fail";

export interface AuditFinding {
  level: "fail" | "warn" | "info";
  message: string;
  /** The seam-side fix — every finding points at what the developer changes. */
  fix?: string;
}

export type AuditCheckKey =
  | "BOUNDARY"
  | "IMPORTS"
  | "ATTESTATIONS"
  | "ROUTES"
  | "ENV"
  | "SPRAWL";

export interface AuditCheck {
  key: AuditCheckKey;
  level: AuditLevel;
  /** One-line headline for the report row. */
  summary: string;
  findings: AuditFinding[];
}

export interface AuditResult {
  ok: boolean;
  parts: number;
  checks: AuditCheck[];
  counts: { pass: number; warn: number; fail: number };
}

/**
 * `partkit audit` — one verb that asks a single question: *did this repo
 * respect its contracts?* It composes the shipped guarantees (`guard` +
 * `verify`) and adds three contract-derived checks (routes mounted, env wired,
 * no hand-rolled sprawl).
 *
 * Scope law (docs/internal): every check traces to a field in contract.json or
 * parts.lock — never an opinion about whether your code is *good*. Only the
 * mechanical checks (boundary, imports, attestation integrity) can FAIL the
 * build; the heuristic checks (routes, env, sprawl) only ever WARN, even under
 * --strict, because a false positive that reddens a stranger's CI would spend
 * the trust the report exists to earn. So `partkit audit` gates exactly what
 * `guard` + `verify` already gate, and adds guidance on top.
 */
export async function auditRepo(
  repoRoot: string,
  opts: { strict?: boolean; now?: Date } = {},
): Promise<AuditResult> {
  const strict = opts.strict ?? false;
  const lf = await readLockfile(repoRoot);

  if (!lf) {
    const check: AuditCheck = {
      key: "BOUNDARY",
      level: "fail",
      summary: `no ${LOCKFILE_NAME} — run \`partkit init\` first`,
      findings: [
        { level: "fail", message: `No ${LOCKFILE_NAME} found.`, fix: "Run `partkit init`." },
      ],
    };
    return { ok: false, parts: 0, checks: [check], counts: { pass: 0, warn: 0, fail: 1 } };
  }

  const partNames = Object.keys(lf.parts);
  const contracts = await loadContracts(repoRoot, partNames);
  const appFiles = await appSourceFiles(repoRoot);
  const checks: AuditCheck[] = [];

  // ── BOUNDARY: parts/** matches parts.lock (hash + tracking) ──────────────
  {
    const problems = await boundaryHashProblems(repoRoot, lf);
    checks.push({
      key: "BOUNDARY",
      level: problems.length > 0 ? "fail" : "pass",
      summary:
        problems.length > 0
          ? `${problems.length} interior(s) drifted from parts.lock`
          : `parts/** matches parts.lock (${partNames.length} part(s))`,
      findings: problems.map((p) => ({
        level: "fail" as const,
        message: p,
        fix: "Restore with `git checkout HEAD -- parts/`, then change your side of the seam.",
      })),
    });
  }

  // ── IMPORTS: app code imports only parts/<name>/src/index ────────────────
  {
    const problems = await importBoundaryProblems(repoRoot);
    checks.push({
      key: "IMPORTS",
      level: problems.length > 0 ? "fail" : "pass",
      summary:
        problems.length > 0
          ? `${problems.length} import(s) reach into part interiors`
          : "no interior imports outside parts/",
      findings: problems.map((p) => ({
        level: "fail" as const,
        message: p,
        fix: "Import only `parts/<name>/src/index` — the public surface the attestation covers.",
      })),
    });
  }

  // ── ATTESTATIONS: integrity (fail) + freshness/signing (warn) ────────────
  {
    const verify = await verifyRepo(repoRoot, { strict, ...(opts.now && { now: opts.now }) });
    // Boundary-class findings are owned by BOUNDARY above; show only the
    // attestation-specific ones here to avoid double-reporting a tamper.
    const boundaryCodes = new Set(["NO_LOCKFILE", "UNTRACKED", "MISSING", "INTEGRITY"]);
    const findings = verify.findings.filter((f) => !boundaryCodes.has(f.code));
    const fails = findings.filter((f) => f.level === "fail").length;
    const warns = findings.filter((f) => f.level === "warn").length;
    const devTier = findings.filter((f) => f.code === "UNSIGNED").length;
    checks.push({
      key: "ATTESTATIONS",
      level: fails > 0 ? "fail" : warns > 0 ? "warn" : "pass",
      summary:
        fails > 0
          ? `${fails} attestation issue(s) across ${verify.checked} part(s)`
          : `${verify.checked} attestation(s) verified offline` +
            (devTier > 0 ? ` · ${devTier} dev-tier` : ""),
      findings: findings.map((f) => ({
        level: f.level,
        message: `${f.part}: ${f.message}`,
        ...fixFor(f.code),
      })),
    });
  }

  // ── ROUTES: declared http_routes appear mounted in app code (warn) ───────
  {
    const findings: AuditFinding[] = [];
    let declared = 0;
    for (const name of partNames) {
      const contract = contracts.get(name);
      if (!contract) continue;
      for (const r of contract.interface.http_routes) {
        declared++;
        if (!routeLooksMounted(appFiles, name, r.export)) {
          findings.push({
            level: "warn",
            message: `${name}: couldn't confirm "${r.route}" is mounted`,
            fix: `Re-export \`${r.export}\` from \`@/parts/${name}\` in your route file (see parts/${name}/seams.md).`,
          });
        }
      }
    }
    checks.push({
      key: "ROUTES",
      level: findings.length > 0 ? "warn" : "pass",
      summary:
        declared === 0
          ? "no part declares an http route"
          : findings.length > 0
            ? `${findings.length} of ${declared} declared route(s) not confirmed mounted`
            : `${declared} declared route(s) mounted`,
      findings,
    });
  }

  // ── ENV: required env keys present in .env.example / .env (warn) ─────────
  {
    const envText = await readEnvText(repoRoot);
    const findings: AuditFinding[] = [];
    let required = 0;
    for (const name of partNames) {
      const contract = contracts.get(name);
      if (!contract) continue;
      for (const [key, spec] of Object.entries(contract.env)) {
        if (!spec.required) continue;
        required++;
        if (!envHasKey(envText, key) && process.env[key] === undefined) {
          findings.push({
            level: "warn",
            message: `${name}: required env ${key} not found in .env.example`,
            fix: `Add ${key}= to .env.example (and set it in your environment).`,
          });
        }
      }
    }
    checks.push({
      key: "ENV",
      level: findings.length > 0 ? "warn" : "pass",
      summary:
        required === 0
          ? "no part requires env"
          : findings.length > 0
            ? `${findings.length} of ${required} required env key(s) not scaffolded`
            : `${required} required env key(s) present`,
      findings,
    });
  }

  // ── SPRAWL: hand-rolled infrastructure a verified part covers (warn) ─────
  {
    const installed = new Set<string>();
    for (const entry of Object.values(lf.parts)) {
      for (const p of entry.provides) installed.add(capabilityOf(p));
    }
    const findings = await sprawlFindings(repoRoot, appFiles, installed);
    checks.push({
      key: "SPRAWL",
      level: findings.length > 0 ? "warn" : "pass",
      summary:
        findings.length > 0
          ? `${findings.length} hand-rolled infrastructure signal(s)`
          : "no hand-rolled infrastructure a part covers",
      findings,
    });
  }

  const counts = {
    pass: checks.filter((c) => c.level === "pass").length,
    warn: checks.filter((c) => c.level === "warn").length,
    fail: checks.filter((c) => c.level === "fail").length,
  };
  return { ok: counts.fail === 0, parts: partNames.length, checks, counts };
}

async function loadContracts(
  repoRoot: string,
  names: string[],
): Promise<Map<string, Contract>> {
  const map = new Map<string, Contract>();
  for (const name of names) {
    try {
      const raw = await readFile(path.join(repoRoot, "parts", name, "contract.json"), "utf8");
      const parsed = ContractSchema.safeParse(JSON.parse(raw));
      if (parsed.success) map.set(name, parsed.data);
    } catch {
      // Missing/invalid contracts are a BOUNDARY/ATTESTATIONS concern, not ours.
    }
  }
  return map;
}

/**
 * A declared route is "mounted" if some app file both imports from the part
 * and references the named export — the canonical seam being
 * `export { handler as POST } from "@/parts/<name>"`. Heuristic, hence warn.
 */
function routeLooksMounted(
  appFiles: { file: string; text: string }[],
  part: string,
  exportName: string,
): boolean {
  const exportRe = new RegExp(`\\b${escapeRe(exportName)}\\b`);
  for (const { text } of appFiles) {
    const refsPart = importSpecifiers(text).some((s) => s.includes(`parts/${part}`));
    if (refsPart && exportRe.test(text)) return true;
  }
  return false;
}

async function readEnvText(repoRoot: string): Promise<string> {
  let combined = "";
  for (const f of [".env.example", ".env"]) {
    try {
      combined += `\n${await readFile(path.join(repoRoot, f), "utf8")}`;
    } catch {
      // optional
    }
  }
  return combined;
}

function envHasKey(envText: string, key: string): boolean {
  return new RegExp(`^\\s*(?:export\\s+)?${escapeRe(key)}\\s*=`, "m").test(envText);
}

/**
 * Capability → the verified part that covers it, and the npm packages whose
 * presence in *app* code (outside parts/) signals a hand-rolled version. Built
 * in for v0; a future RFC moves fingerprints into the registry so the catalog
 * owns them. Conservative on purpose — every finding only ever warns.
 */
const FINGERPRINTS: { capability: string; part: string; packages: string[] }[] = [
  {
    capability: "auth.session",
    part: "auth.session",
    packages: [
      "better-auth",
      "next-auth",
      "@auth/core",
      "lucia",
      "passport",
      "jsonwebtoken",
      "jose",
      "bcrypt",
      "bcryptjs",
      "argon2",
      "@node-rs/argon2",
    ],
  },
  {
    capability: "billing.subscription",
    part: "billing.subscription",
    packages: ["stripe", "@paddle/paddle-node-sdk", "braintree", "@lemonsqueezy/lemonsqueezy.js"],
  },
  {
    capability: "email.transactional",
    part: "email.transactional",
    packages: [
      "nodemailer",
      "@sendgrid/mail",
      "resend",
      "postmark",
      "@aws-sdk/client-ses",
      "mailgun.js",
      "@mailchimp/mailchimp_transactional",
    ],
  },
  {
    capability: "jobs.queue",
    part: "jobs.queue",
    packages: ["bullmq", "bull", "bee-queue", "agenda", "@hokify/agenda", "pg-boss", "graphile-worker"],
  },
  { capability: "webhooks.ingest", part: "webhooks.ingest", packages: ["svix"] },
  {
    capability: "ratelimit.api",
    part: "ratelimit.api",
    packages: ["@upstash/ratelimit", "rate-limiter-flexible", "express-rate-limit", "limiter"],
  },
  {
    capability: "storage.upload",
    part: "storage.upload",
    packages: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "multer", "@google-cloud/storage", "minio"],
  },
];

async function sprawlFindings(
  repoRoot: string,
  appFiles: { file: string; text: string }[],
  installed: Set<string>,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const seen = new Set<string>();
  const pkgIndex = new Map<string, { capability: string; part: string }>();
  for (const fp of FINGERPRINTS) {
    for (const pkg of fp.packages) pkgIndex.set(pkg, { capability: fp.capability, part: fp.part });
  }
  const matchPkg = (spec: string): { capability: string; part: string } | undefined => {
    const direct = pkgIndex.get(spec);
    if (direct) return direct;
    // scoped or sub-path import, e.g. "@aws-sdk/client-s3/foo"
    for (const [pkg, hit] of pkgIndex) {
      if (spec === pkg || spec.startsWith(`${pkg}/`)) return hit;
    }
    return undefined;
  };

  // Primary, precise signal: an app file imports a fingerprint package.
  for (const { file, text } of appFiles) {
    for (const spec of importSpecifiers(text)) {
      const hit = matchPkg(spec);
      if (!hit) continue;
      const dedupe = `${file}|${spec}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      if (installed.has(hit.capability)) {
        findings.push({
          level: "warn",
          message: `${file} imports "${spec}" — ${hit.part} is installed; this bypasses the verified part`,
          fix: `Wire ${hit.capability} through parts/${hit.part}/seams.md instead of importing "${spec}" directly.`,
        });
      } else {
        findings.push({
          level: "warn",
          message: `${file} imports "${spec}" — a verified part covers ${hit.capability}`,
          fix: `Run \`partkit add ${hit.part}\` and wire it from its seams.md.`,
        });
      }
    }
  }

  // Secondary, softer signal: package.json depends on a fingerprint package
  // for a capability that is NOT installed (a gap). When the part IS installed
  // its own npm_dependencies legitimately live here, so we skip those.
  try {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const dep of Object.keys(deps)) {
      const hit = matchPkg(dep);
      if (!hit || installed.has(hit.capability)) continue;
      const capKey = `pkgjson|${hit.capability}`;
      if (seen.has(capKey)) continue;
      // Don't double-report if an app import for the same capability already fired.
      if (findings.some((f) => f.message.includes(`covers ${hit.capability}`))) continue;
      seen.add(capKey);
      findings.push({
        level: "warn",
        message: `package.json depends on "${dep}" — a verified part covers ${hit.capability}`,
        fix: `Run \`partkit add ${hit.part}\` and wire it from its seams.md.`,
      });
    }
  } catch {
    // no package.json — nothing to add
  }

  return findings;
}

function fixFor(code: string): { fix?: string } {
  switch (code) {
    case "STALE":
      return { fix: "Run `partkit upgrade <part>` to pull a freshly re-attested version." };
    case "UNSIGNED":
      return { fix: "Dev-tier is fine locally; real signing lands before production use." };
    case "NPM_DEP_MISSING":
    case "NPM_DEP_RANGE":
      return { fix: "Install the contract's npm dependency in range (your package manager's install)." };
    default:
      return {};
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
