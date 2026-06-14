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
    expect(res.version).toBe("1.1.0");
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
    expect(agents).toContain("email.transactional@1.1.0");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true); // dev-unsigned (and later staleness) are warnings, not failures
  });

  it("adds with --adapter=ses, scaffolds the AWS env + vendored SigV4 signer, verifies green", async () => {
    const repo2 = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo2, { recursive: true });
    execFileSync("git", ["init", "-q", repo2]);
    await initRepo(repo2, { registrySource: REPO_REGISTRY });

    const res = await addPart(repo2, { name: "email.transactional", adapter: "ses" });
    expect(res.version).toBe("1.1.0");
    expect(res.adapter).toBe("ses");
    expect(res.envKeys).toEqual(
      expect.arrayContaining(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"]),
    );

    await stat(path.join(repo2, "parts/email.transactional/adapters/selected/adapter.ts"));
    // the SES adapter's SigV4 signer ships as vendored interior (zero npm deps, no aws-sdk)
    await stat(path.join(repo2, "parts/email.transactional/src/internal/sigv4.ts"));
    await expect(
      stat(path.join(repo2, "parts/email.transactional/adapters/ses")),
    ).rejects.toThrow(); // only the flattened selected adapter is vendored

    const env = await readFile(path.join(repo2, ".env.example"), "utf8");
    expect(env).toContain("EMAIL_ADAPTER=ses");
    expect(env).toContain("AWS_ACCESS_KEY_ID=");

    const ver = await verifyRepo(repo2);
    expect(ver.ok).toBe(true);
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
    expect(res.version).toBe("1.1.0");

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("email.transactional@1.1.0");
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
    expect(res.version).toBe("1.1.0"); // 1.1.0 added data_ownership.reads (RFC 0004)
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
    expect(agents).toContain("auth.tenancy@1.1.0");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });

  it("coexists with auth.session — the saas tenancy pairing installs side by side", async () => {
    // auth.tenancy references auth.session's principal; the two are distinct
    // capabilities, so they coexist (no anti-sprawl conflict).
    const res = await addPart(repo, { name: "auth.session" });
    expect(res.version).toBe("1.0.0");

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("auth.tenancy@1.1.0");
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

describe("real registry: jobs.queue installs end-to-end (OSS-wrap; provides jobs.queue@1 + jobs.cron@1)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    // jobs.queue declares graphile-worker in npm_dependencies, so the repo needs
    // a package.json to merge into.
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "app", version: "0.0.0" }));
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, merges graphile-worker, vendors the migration, scaffolds no env, verifies green", async () => {
    const res = await addPart(repo, { name: "jobs.queue" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBeNull(); // graphile-worker is the wrapped library, not an adapter axis
    expect(res.envKeys).toEqual([]); // connection is passed in code (SqlExecutor + connectionString)

    await stat(path.join(repo, "parts/jobs.queue/src/index.ts"));
    await stat(path.join(repo, "parts/jobs.queue/seams.md"));
    await stat(path.join(repo, "parts/jobs.queue/examples/worker-entrypoint.ts"));
    await stat(path.join(repo, "parts/jobs.queue/examples/serverless-drain.ts"));
    await stat(path.join(repo, "parts/jobs.queue/ATTESTATION.json"));
    // owns a schema → its migration is vendored
    await stat(path.join(repo, "parts/jobs.queue/migrations/001-install-graphile-worker.sql"));
    await expect(stat(path.join(repo, "parts/jobs.queue/adapters"))).rejects.toThrow();
    await expect(stat(path.join(repo, ".env.example"))).rejects.toThrow();

    // npm_dependencies (RFC 0001) merged into the consumer's package.json
    const pkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["graphile-worker"]).toBeDefined();

    // DB-backed → flagged to run partkit migrate
    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(true);

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("jobs.queue@1.0.0");

    // verify requires the declared dep installed (RFC 0001 §2b); simulate a
    // consumer install at the attestation-pinned version.
    await mkdir(path.join(repo, "node_modules", "graphile-worker"), { recursive: true });
    await writeFile(
      path.join(repo, "node_modules", "graphile-worker", "package.json"),
      JSON.stringify({ name: "graphile-worker", version: "0.16.6" }),
    );

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: admin.crud installs end-to-end (RFC 0004; owns no tables; requires auth.session)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, no env, no migration (owns no tables), verifies green", async () => {
    const res = await addPart(repo, { name: "admin.crud" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBeNull(); // schema-driven, no adapter axis
    expect(res.envKeys).toEqual([]); // configured in code (resources + db + mutators)

    await stat(path.join(repo, "parts/admin.crud/src/index.ts"));
    await stat(path.join(repo, "parts/admin.crud/seams.md"));
    await stat(path.join(repo, "parts/admin.crud/examples/admin-routes.ts"));
    await stat(path.join(repo, "parts/admin.crud/ATTESTATION.json"));
    await expect(stat(path.join(repo, "parts/admin.crud/adapters"))).rejects.toThrow();
    await expect(stat(path.join(repo, ".env.example"))).rejects.toThrow();

    // admin.crud owns no tables → no migration, no migrate flag
    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(false);

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("admin.crud@1.0.0");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: billing.subscription installs end-to-end (stripe adapter; OSS-wrap + env + migration; requires auth.session)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    // billing declares stripe in the stripe adapter's npm_dependencies → needs a package.json.
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "app", version: "0.0.0" }));
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("auto-selects the single stripe adapter, scaffolds env, merges stripe, vendors the migration, verifies green", async () => {
    const res = await addPart(repo, { name: "billing.subscription" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBe("stripe"); // one installable adapter → auto-selected
    expect(res.envKeys).toEqual(expect.arrayContaining(["BILLING_SECRET_KEY", "BILLING_WEBHOOK_SECRET"]));

    await stat(path.join(repo, "parts/billing.subscription/src/index.ts"));
    await stat(path.join(repo, "parts/billing.subscription/adapters/selected/adapter.ts"));
    await stat(path.join(repo, "parts/billing.subscription/seams.md"));
    await stat(path.join(repo, "parts/billing.subscription/examples/webhook-route.ts"));
    await stat(path.join(repo, "parts/billing.subscription/migrations/001-create-billing-tables.sql"));
    await stat(path.join(repo, "parts/billing.subscription/ATTESTATION.json"));
    // only the selected adapter is vendored
    await expect(stat(path.join(repo, "parts/billing.subscription/adapters/stripe"))).rejects.toThrow();

    const envExample = await readFile(path.join(repo, ".env.example"), "utf8");
    expect(envExample).toContain("BILLING_SECRET_KEY");
    expect(envExample).toContain("BILLING_WEBHOOK_SECRET");

    // per-adapter npm_dependencies (RFC 0001) merged into the consumer's package.json
    const pkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["stripe"]).toBeDefined();

    // owns tables → flagged to run partkit migrate
    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(true);

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("billing.subscription@1.0.0");

    // verify requires the declared dep installed in-range (RFC 0001 §2b); simulate
    // a consumer install at the attestation-pinned version. `requires: auth.session`
    // is resolver-only — verify does not need auth.session present.
    await mkdir(path.join(repo, "node_modules", "stripe"), { recursive: true });
    await writeFile(
      path.join(repo, "node_modules", "stripe", "package.json"),
      JSON.stringify({ name: "stripe", version: "22.2.1" }),
    );

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: auth.apikey installs end-to-end (programmatic key auth; zero-dep, DB-backed)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, no env, vendors the migration + internal hash, verifies green", async () => {
    const res = await addPart(repo, { name: "auth.apikey" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBeNull(); // the connection is an app seam, not a vendored adapter
    expect(res.envKeys).toEqual([]); // zero-dep + driver-free: no env, the app hands in a SqlExecutor

    await stat(path.join(repo, "parts/auth.apikey/src/index.ts"));
    await stat(path.join(repo, "parts/auth.apikey/seams.md"));
    await stat(path.join(repo, "parts/auth.apikey/examples/protect-route.ts"));
    await stat(path.join(repo, "parts/auth.apikey/examples/key-dashboard.ts"));
    await stat(path.join(repo, "parts/auth.apikey/ATTESTATION.json"));
    // the crypto core is vendored as a part internal
    await stat(path.join(repo, "parts/auth.apikey/src/internal/keys.ts"));
    // owns a table → its migration is vendored; ships no adapters dir
    await stat(path.join(repo, "parts/auth.apikey/migrations/001-create-apikey-tables.sql"));
    await expect(stat(path.join(repo, "parts/auth.apikey/adapters"))).rejects.toThrow();
    await expect(stat(path.join(repo, ".env.example"))).rejects.toThrow();

    // a DB-backed part is flagged so the consumer knows to run `partkit migrate`
    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(true);

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("auth.apikey@1.0.0");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: webhooks.dispatch installs end-to-end (outbound signed webhooks; zero-dep, DB-backed)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, no env, vendors the migration + internal signer, verifies green", async () => {
    const res = await addPart(repo, { name: "webhooks.dispatch" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBeNull(); // the connection is an app seam, not a vendored adapter
    expect(res.envKeys).toEqual([]); // zero-dep + driver-free: no env, the app hands in a SqlExecutor

    await stat(path.join(repo, "parts/webhooks.dispatch/src/index.ts"));
    await stat(path.join(repo, "parts/webhooks.dispatch/seams.md"));
    await stat(path.join(repo, "parts/webhooks.dispatch/examples/jobs-wiring.ts"));
    await stat(path.join(repo, "parts/webhooks.dispatch/ATTESTATION.json"));
    // the Standard Webhooks signer + SSRF guard are vendored as part internals
    await stat(path.join(repo, "parts/webhooks.dispatch/src/internal/sign.ts"));
    await stat(path.join(repo, "parts/webhooks.dispatch/src/internal/ssrf.ts"));
    // owns tables → its migration is vendored; ships no adapters dir
    await stat(path.join(repo, "parts/webhooks.dispatch/migrations/001-create-dispatch-tables.sql"));
    await expect(stat(path.join(repo, "parts/webhooks.dispatch/adapters"))).rejects.toThrow();
    await expect(stat(path.join(repo, ".env.example"))).rejects.toThrow();

    // a DB-backed part is flagged so the consumer knows to run `partkit migrate`
    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(true);

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("webhooks.dispatch@1.0.0");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: billing.usage installs end-to-end (metered-usage ledger; stripe Meters adapter)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    // the stripe adapter declares stripe in its npm_dependencies → needs a package.json.
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "app", version: "0.0.0" }));
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("auto-selects the single stripe adapter, merges stripe, vendors the migration, verifies green", async () => {
    const res = await addPart(repo, { name: "billing.usage" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBe("stripe"); // one installable adapter → auto-selected
    expect(res.envKeys).toEqual(expect.arrayContaining(["BILLING_USAGE_SECRET_KEY"]));

    await stat(path.join(repo, "parts/billing.usage/src/index.ts"));
    await stat(path.join(repo, "parts/billing.usage/adapters/selected/adapter.ts"));
    await stat(path.join(repo, "parts/billing.usage/seams.md"));
    await stat(path.join(repo, "parts/billing.usage/examples/record-usage.ts"));
    await stat(path.join(repo, "parts/billing.usage/migrations/001-create-usage-tables.sql"));
    await stat(path.join(repo, "parts/billing.usage/ATTESTATION.json"));
    // only the selected adapter is vendored
    await expect(stat(path.join(repo, "parts/billing.usage/adapters/stripe"))).rejects.toThrow();

    // per-adapter npm_dependencies (RFC 0001) merged into the consumer's package.json
    const pkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["stripe"]).toBeDefined();

    // owns a table → flagged to run partkit migrate
    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(true);

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("billing.usage@1.0.0");

    // verify requires the declared dep installed in-range (RFC 0001 §2b).
    await mkdir(path.join(repo, "node_modules", "stripe"), { recursive: true });
    await writeFile(
      path.join(repo, "node_modules", "stripe", "package.json"),
      JSON.stringify({ name: "stripe", version: "22.2.1" }),
    );

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: flags.feature installs end-to-end (feature flags; zero-dep, DB-backed)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, no env, vendors the migration + internal eval, verifies green", async () => {
    const res = await addPart(repo, { name: "flags.feature" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBeNull();
    expect(res.envKeys).toEqual([]); // zero-dep + driver-free: no env

    await stat(path.join(repo, "parts/flags.feature/src/index.ts"));
    await stat(path.join(repo, "parts/flags.feature/seams.md"));
    await stat(path.join(repo, "parts/flags.feature/examples/use-flags.ts"));
    await stat(path.join(repo, "parts/flags.feature/src/internal/eval.ts"));
    await stat(path.join(repo, "parts/flags.feature/migrations/001-create-feature-flags.sql"));
    await stat(path.join(repo, "parts/flags.feature/ATTESTATION.json"));
    await expect(stat(path.join(repo, "parts/flags.feature/adapters"))).rejects.toThrow();
    await expect(stat(path.join(repo, ".env.example"))).rejects.toThrow();

    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(true);
    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("flags.feature@1.0.0");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});

describe("real registry: search.fulltext installs end-to-end (Postgres FTS; zero-dep, DB-backed)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = path.join(await makeTempDir("partkit-realreg-"), "app");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await initRepo(repo, { registrySource: REPO_REGISTRY });
  });

  it("adds with no adapter, no env, vendors the FTS migration, verifies green", async () => {
    const res = await addPart(repo, { name: "search.fulltext" });
    expect(res.version).toBe("1.0.0");
    expect(res.adapter).toBeNull();
    expect(res.envKeys).toEqual([]); // zero-dep + driver-free: no env

    await stat(path.join(repo, "parts/search.fulltext/src/index.ts"));
    await stat(path.join(repo, "parts/search.fulltext/seams.md"));
    await stat(path.join(repo, "parts/search.fulltext/examples/index-and-search.ts"));
    await stat(path.join(repo, "parts/search.fulltext/migrations/001-create-search-documents.sql"));
    await stat(path.join(repo, "parts/search.fulltext/ATTESTATION.json"));
    await expect(stat(path.join(repo, "parts/search.fulltext/adapters"))).rejects.toThrow();
    await expect(stat(path.join(repo, ".env.example"))).rejects.toThrow();

    expect(res.warnings.some((w) => /migrat/i.test(w))).toBe(true);
    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("search.fulltext@1.0.0");

    const ver = await verifyRepo(repo);
    expect(ver.ok).toBe(true);
  });
});
