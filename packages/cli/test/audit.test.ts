import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addPart, auditRepo, initRepo, type AuditResult } from "@part-kit/core";
import { makeFixtureRegistry, makeTempDir } from "./helpers";

const byKey = (res: AuditResult, key: string) => res.checks.find((c) => c.key === key)!;

describe("partkit audit — did this repo respect its contracts?", () => {
  let repo: string;
  let registry: string;

  beforeAll(async () => {
    const root = await makeTempDir("partkit-audit-");
    registry = await makeFixtureRegistry(root);
    repo = path.join(root, "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: registry });
    await addPart(repo, { name: "testing.echo", adapter: "alpha" });
  });

  it("a clean repo passes: boundary + imports green, attestation warns dev-tier, no failures", async () => {
    const res = await auditRepo(repo);
    expect(res.ok).toBe(true);
    expect(byKey(res, "BOUNDARY").level).toBe("pass");
    expect(byKey(res, "IMPORTS").level).toBe("pass");
    expect(byKey(res, "ATTESTATIONS").level).toBe("warn"); // dev:unsigned
    expect(byKey(res, "ENV").level).toBe("pass"); // add scaffolds ECHO_ADAPTER + ECHO_SECRET
    expect(byKey(res, "ROUTES").level).toBe("pass"); // echo declares none
    expect(byKey(res, "SPRAWL").level).toBe("pass");
    expect(res.counts.fail).toBe(0);
  });

  it("--strict escalates the dev-tier attestation to a failure", async () => {
    const res = await auditRepo(repo, { strict: true });
    expect(byKey(res, "ATTESTATIONS").level).toBe("fail");
    expect(res.ok).toBe(false);
  });

  it("tampering a part interior fails BOUNDARY", async () => {
    const f = path.join(repo, "parts/testing.echo/src/index.ts");
    const orig = await readFile(f, "utf8");
    await writeFile(f, `${orig}\n// tamper\n`);
    try {
      const res = await auditRepo(repo);
      expect(byKey(res, "BOUNDARY").level).toBe("fail");
      expect(res.ok).toBe(false);
    } finally {
      await writeFile(f, orig);
    }
  });

  it("an app import of a part interior fails IMPORTS", async () => {
    const appf = path.join(repo, "src", "bad.ts");
    await mkdir(path.dirname(appf), { recursive: true });
    await writeFile(
      appf,
      `import { INTERNAL } from "../parts/testing.echo/src/internal/impl";\nexport const x = INTERNAL;\n`,
    );
    try {
      const res = await auditRepo(repo);
      expect(byKey(res, "IMPORTS").level).toBe("fail");
      expect(res.ok).toBe(false);
    } finally {
      await rm(appf);
    }
  });

  it("a missing required env key warns but never fails", async () => {
    const envPath = path.join(repo, ".env.example");
    const orig = await readFile(envPath, "utf8");
    await writeFile(
      envPath,
      orig
        .split("\n")
        .filter((l) => !l.startsWith("ECHO_SECRET"))
        .join("\n"),
    );
    try {
      const res = await auditRepo(repo);
      const env = byKey(res, "ENV");
      expect(env.level).toBe("warn");
      expect(env.findings.some((f) => f.message.includes("ECHO_SECRET"))).toBe(true);
      expect(res.ok).toBe(true);
    } finally {
      await writeFile(envPath, orig);
    }
  });

  it("flags hand-rolled infrastructure a verified part covers (sprawl gap), without failing", async () => {
    const appf = path.join(repo, "src", "mailer.ts");
    await mkdir(path.dirname(appf), { recursive: true });
    await writeFile(appf, `import nodemailer from "nodemailer";\nexport const t = nodemailer;\n`);
    try {
      const res = await auditRepo(repo);
      const sprawl = byKey(res, "SPRAWL");
      expect(sprawl.level).toBe("warn");
      expect(sprawl.findings.some((f) => f.message.includes("email.transactional"))).toBe(true);
      expect(res.ok).toBe(true);
    } finally {
      await rm(appf);
    }
  });

  it("fails clearly when there is no lockfile", async () => {
    const root = await makeTempDir("partkit-audit-nolock-");
    const res = await auditRepo(root);
    expect(res.ok).toBe(false);
    expect(byKey(res, "BOUNDARY").summary).toMatch(/parts\.lock/);
  });
});

describe("partkit audit — route mounting (heuristic, warn-tier)", () => {
  let repo: string;

  beforeAll(async () => {
    const root = await makeTempDir("partkit-audit-routes-");
    repo = path.join(root, "app");
    const partDir = path.join(repo, "parts", "webhooks.ingest");
    await mkdir(partDir, { recursive: true });
    const contract = {
      part: "webhooks.ingest",
      version: "1.0.0",
      contract_version: "0.1",
      provides: ["webhooks.ingest@1"],
      requires: [],
      platform: {},
      adapters: [],
      interface: {
        exports: ["webhookHandler(r: Request): Promise<Response>"],
        events: [],
        http_routes: [{ route: "POST /api/webhooks/ingest", export: "webhookHandler" }],
      },
      env: {},
      invariants: [],
      license: "MIT",
    };
    await writeFile(path.join(partDir, "contract.json"), JSON.stringify(contract));
    const lockfile = {
      lockfile_version: 1,
      registry: { source: "test" },
      parts: {
        "webhooks.ingest": {
          version: "1.0.0",
          adapter: null,
          provides: ["webhooks.ingest@1"],
          content_hash: `sha256:${"0".repeat(64)}`,
          attestation: {
            verified_at: "2026-01-01T00:00:00.000Z",
            expires: "2030-01-01T00:00:00.000Z",
            signature: "dev:unsigned",
            result_hash: `sha256:${"0".repeat(64)}`,
          },
          provenance: "test",
        },
      },
    };
    await writeFile(path.join(repo, "parts.lock"), JSON.stringify(lockfile));
  });

  it("warns when a declared route is not mounted", async () => {
    const res = await auditRepo(repo);
    expect(byKey(res, "ROUTES").level).toBe("warn");
  });

  it("passes once the export is re-mounted in an app route file", async () => {
    const routeFile = path.join(repo, "app", "api", "webhooks", "ingest", "route.ts");
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(routeFile, `export { webhookHandler as POST } from "@/parts/webhooks.ingest";\n`);
    const res = await auditRepo(repo);
    expect(byKey(res, "ROUTES").level).toBe("pass");
  });
});
