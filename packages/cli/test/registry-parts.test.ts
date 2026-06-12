/**
 * Consumer-side proof for REAL registry content: every published part must
 * install end-to-end (init → add → verify) from this repo's registry/.
 * If a part's content changes without re-running registry:publish, the
 * integrity check here fails — that is the point.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { addPart, initRepo, verifyRepo } from "@part-kit/core";
import { makeTempDir } from "./helpers";

const REPO_REGISTRY = fileURLToPath(new URL("../../../registry", import.meta.url));

describe("real registry: email.transactional installs end-to-end", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with --adapter=resend, vendors the flattened adapter, scaffolds env, verifies green", async () => {
    const res = await addPart(repo, { name: "email.transactional", adapter: "resend" });
    expect(res.version).toBe("1.0.1");
    expect(res.adapter).toBe("resend");

    await stat(path.join(repo, "parts/email.transactional/src/index.ts"));
    await stat(path.join(repo, "parts/email.transactional/adapters/selected/adapter.ts"));
    await stat(path.join(repo, "parts/email.transactional/seams.md"));
    await stat(path.join(repo, "parts/email.transactional/examples/welcome-email.ts"));
    await stat(path.join(repo, "parts/email.transactional/ATTESTATION.json"));
    // non-selected adapter is not vendored
    await expect(
      stat(path.join(repo, "parts/email.transactional/adapters/postmark")),
    ).rejects.toThrow();

    const env = await readFile(path.join(repo, ".env.example"), "utf8");
    expect(env).toContain("EMAIL_ADAPTER=resend");
    expect(env).toContain("EMAIL_FROM=");
    expect(env).toContain("RESEND_API_KEY=");

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("email.transactional@1.0.1");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true); // dev-unsigned (and later staleness) are warnings, not failures
  });
});

describe("real registry: webhooks.ingest installs end-to-end", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with --adapter=stripe, vendors the flattened adapter, scaffolds env, verifies green", async () => {
    const res = await addPart(repo, { name: "webhooks.ingest", adapter: "stripe" });
    expect(res.version).toBe("1.0.1");
    expect(res.adapter).toBe("stripe");

    await stat(path.join(repo, "parts/webhooks.ingest/src/index.ts"));
    await stat(path.join(repo, "parts/webhooks.ingest/adapters/selected/adapter.ts"));
    await stat(path.join(repo, "parts/webhooks.ingest/seams.md"));
    await stat(path.join(repo, "parts/webhooks.ingest/examples/next-route.ts"));
    await stat(path.join(repo, "parts/webhooks.ingest/ATTESTATION.json"));
    // non-selected adapter is not vendored
    await expect(
      stat(path.join(repo, "parts/webhooks.ingest/adapters/standardwebhooks")),
    ).rejects.toThrow();

    const env = await readFile(path.join(repo, ".env.example"), "utf8");
    expect(env).toContain("WEBHOOK_ADAPTER=stripe");
    expect(env).toContain("WEBHOOK_SECRET=");
    expect(env).toContain("WEBHOOK_TOLERANCE_SECONDS=");

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("webhooks.ingest@1.0.1");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });

  it("coexists with email.transactional — first two-part repo, no capability overlap", async () => {
    const res = await addPart(repo, { name: "email.transactional", adapter: "resend" });
    expect(res.version).toBe("1.0.1");

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("email.transactional@1.0.1");
    expect(agents).toContain("webhooks.ingest@1.0.1");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: ratelimit.api installs end-to-end (zero adapters, zero env)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, vendors no adapters/ dir, scaffolds no env, verifies green", async () => {
    const res = await addPart(repo, { name: "ratelimit.api" });
    expect(res.version).toBe("1.0.1");
    expect(res.adapter).toBeNull(); // the store is an app seam, not a vendored adapter
    expect(res.envKeys).toEqual([]); // configured in code, not env

    await stat(path.join(repo, "parts/ratelimit.api/src/index.ts"));
    await stat(path.join(repo, "parts/ratelimit.api/seams.md"));
    await stat(path.join(repo, "parts/ratelimit.api/examples/next-middleware.ts"));
    await stat(path.join(repo, "parts/ratelimit.api/ATTESTATION.json"));
    // a zero-adapter part vendors no adapters/ directory at all
    await expect(stat(path.join(repo, "parts/ratelimit.api/adapters"))).rejects.toThrow();
    // no env scaffolding for a part that declares no env
    await expect(stat(path.join(repo, ".env.example"))).rejects.toThrow();

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("ratelimit.api@1.0.1");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: audit.log installs end-to-end (first DB-backed part)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, vendors the migration, flags it, scaffolds no env, verifies green", async () => {
    const res = await addPart(repo, { name: "audit.log" });
    expect(res.version).toBe("1.0.1");
    expect(res.adapter).toBeNull(); // the connection is an app seam, not a vendored adapter
    expect(res.envKeys).toEqual([]); // driver-free: no env, the app hands in a SqlExecutor

    await stat(path.join(repo, "parts/audit.log/src/index.ts"));
    await stat(path.join(repo, "parts/audit.log/seams.md"));
    await stat(path.join(repo, "parts/audit.log/examples/pg-executor.ts"));
    await stat(path.join(repo, "parts/audit.log/ATTESTATION.json"));
    // the part owns a table → its migration is vendored
    await stat(path.join(repo, "parts/audit.log/migrations/001-create-audit-events.sql"));
    await expect(stat(path.join(repo, "parts/audit.log/adapters"))).rejects.toThrow();
    await expect(stat(path.join(repo, ".env.example"))).rejects.toThrow();

    // a DB-backed part is flagged so the consumer knows to run `partkit migrate`
    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(true);

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("audit.log@1.0.1");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: storage.upload installs end-to-end (zero adapters, env-configured)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, scaffolds the STORAGE_* env (secrets flagged), verifies green", async () => {
    const res = await addPart(repo, { name: "storage.upload" });
    expect(res.version).toBe("1.0.1");
    expect(res.adapter).toBeNull(); // one S3 wire format → no adapters
    expect(res.envKeys).toContain("STORAGE_SECRET_ACCESS_KEY");

    await stat(path.join(repo, "parts/storage.upload/src/index.ts"));
    await stat(path.join(repo, "parts/storage.upload/seams.md"));
    await stat(path.join(repo, "parts/storage.upload/examples/upload-route.ts"));
    await stat(path.join(repo, "parts/storage.upload/ATTESTATION.json"));
    await expect(stat(path.join(repo, "parts/storage.upload/adapters"))).rejects.toThrow();

    const env = await readFile(path.join(repo, ".env.example"), "utf8");
    expect(env).toContain("STORAGE_ENDPOINT=");
    expect(env).toContain("STORAGE_BUCKET=");
    expect(env).toContain("STORAGE_ACCESS_KEY_ID=");
    expect(env).toContain("STORAGE_SECRET_ACCESS_KEY=");
    expect(env).toContain("secret"); // the secret hint is scaffolded into the comment

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("storage.upload@1.0.1");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: auth.session installs end-to-end (first OSS-wrapping part)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    // A part with npm_dependencies requires a consumer package.json to merge into.
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "app", version: "0.0.0" }));
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, merges npm_dependencies, vendors the migration + env, verifies green", async () => {
    const res = await addPart(repo, { name: "auth.session" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBeNull(); // wrapping a library is not an adapter axis

    await stat(path.join(repo, "parts/auth.session/src/index.ts"));
    await stat(path.join(repo, "parts/auth.session/seams.md"));
    await stat(path.join(repo, "parts/auth.session/examples/auth-route.ts"));
    await stat(path.join(repo, "parts/auth.session/ATTESTATION.json"));
    await stat(path.join(repo, "parts/auth.session/migrations/001-create-auth-tables.sql"));
    await expect(stat(path.join(repo, "parts/auth.session/adapters"))).rejects.toThrow();

    // npm_dependencies (RFC 0001) merged into the consumer's package.json
    const pkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["better-auth"]).toBeDefined();
    expect(pkg.dependencies?.["pg"]).toBeDefined();

    const env = await readFile(path.join(repo, ".env.example"), "utf8");
    expect(env).toContain("BETTER_AUTH_SECRET=");
    expect(env).toContain("AUTH_DATABASE_URL=");
    expect(env).toContain("BETTER_AUTH_URL=");

    // DB-backed → flagged to run partkit migrate
    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(true);

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("auth.session@1.0.0");

    // verify requires the declared npm deps to be installed (RFC 0001 §2b);
    // simulate a consumer install at the attestation-pinned versions.
    for (const [dep, version] of [["better-auth", "1.6.16"], ["pg", "8.21.0"]] as const) {
      await mkdir(path.join(repo, "node_modules", dep), { recursive: true });
      await writeFile(
        path.join(repo, "node_modules", dep, "package.json"),
        JSON.stringify({ name: dep, version }),
      );
    }

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: auth.tenancy installs end-to-end (orgs/memberships/scoping; requires auth.session)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    // auth.session (added in the coexistence test below) has npm_dependencies,
    // so the repo needs a package.json to merge into.
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "app", version: "0.0.0" }));
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, vendors the migration, flags it, scaffolds no env, verifies green", async () => {
    const res = await addPart(repo, { name: "auth.tenancy" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBeNull(); // the connection is an app seam, not a vendored adapter
    expect(res.envKeys).toEqual([]); // driver-free, configured in code (no env)

    await stat(path.join(repo, "parts/auth.tenancy/src/index.ts"));
    await stat(path.join(repo, "parts/auth.tenancy/seams.md"));
    await stat(path.join(repo, "parts/auth.tenancy/examples/scoped-route.ts"));
    await stat(path.join(repo, "parts/auth.tenancy/ATTESTATION.json"));
    // the part owns tables → its migration is vendored
    await stat(path.join(repo, "parts/auth.tenancy/migrations/001-create-tenant-tables.sql"));
    await expect(stat(path.join(repo, "parts/auth.tenancy/adapters"))).rejects.toThrow();

    // no env scaffolding for a part that declares no env
    const env = await readFile(path.join(repo, ".env.example"), "utf8").catch(() => "");
    expect(env).toBe("");

    // a DB-backed part is flagged so the consumer knows to run `partkit migrate`
    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(true);

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("auth.tenancy@1.0.0");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });

  it("coexists with auth.session — the saas tenancy pairing installs side by side", async () => {
    // auth.tenancy references auth.session's principal; the two are distinct
    // capabilities, so they coexist (no anti-sprawl conflict).
    const res = await addPart(repo, { name: "auth.session" });
    expect(res.version).toBe("1.0.0");

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("auth.tenancy@1.0.0");
    expect(agents).toContain("auth.session@1.0.0");

    // verify requires auth.session's declared npm deps to be installed (RFC 0001
    // §2b); simulate a consumer install at the attestation-pinned versions.
    for (const [dep, version] of [["better-auth", "1.6.16"], ["pg", "8.21.0"]] as const) {
      await mkdir(path.join(repo, "node_modules", dep), { recursive: true });
      await writeFile(
        path.join(repo, "node_modules", dep, "package.json"),
        JSON.stringify({ name: dep, version }),
      );
    }

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});
