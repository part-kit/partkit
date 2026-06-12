import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  addPart,
  guardRepo,
  initRepo,
  openRegistry,
  readLockfile,
  upgradePart,
  verifyRepo,
} from "@part-kit/core";
import { makeTempDir } from "./helpers";

const REGISTRY_DIR = fileURLToPath(new URL("../../../registry", import.meta.url));

/** Serve the real registry directory over HTTP; optionally corrupt some paths. */
function serveRegistry(corrupt: (urlPath: string) => boolean = () => false): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      const abs = path.join(REGISTRY_DIR, urlPath);
      if (!abs.startsWith(REGISTRY_DIR)) {
        res.writeHead(403).end();
        return;
      }
      try {
        let bytes = await readFile(abs);
        if (corrupt(urlPath)) bytes = Buffer.concat([bytes, Buffer.from("\n// tampered")]);
        res.writeHead(200).end(bytes);
      } catch {
        res.writeHead(404).end("not found");
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const servers: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

async function makeApp(registryUrl: string): Promise<string> {
  const root = await makeTempDir("partkit-http-");
  const repo = path.join(root, "app");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "app" }, null, 2)}\n`);
  await initRepo(repo, { registrySource: registryUrl });
  return repo;
}

describe("the hosted registry over HTTP", () => {
  it("openRegistry routes by scheme and reads index/contract/seams/manifest", async () => {
    const srv = await serveRegistry();
    servers.push(srv);
    const reg = await openRegistry(srv.url);
    const idx = await reg.index();
    expect(Object.keys(idx.parts)).toContain("email.transactional");
    const contract = await reg.contract("email.transactional", "1.0.0");
    expect(contract.part).toBe("email.transactional");
    expect((await reg.seams("ratelimit.api", "1.0.0")).length).toBeGreaterThan(100);
    expect(await reg.capabilitySummary("webhooks.ingest")).toBeTruthy();
  });

  it("vendors a part end-to-end over HTTP: add → verify → guard green, then the flip", async () => {
    const srv = await serveRegistry();
    servers.push(srv);
    const repo = await makeApp(srv.url);

    const res = await addPart(repo, { name: "email.transactional", adapter: "resend" });
    expect(res.version).toBe("1.0.1");
    await stat(path.join(repo, "parts/email.transactional/adapters/selected/adapter.ts"));
    const lf = await readLockfile(repo);
    expect(lf?.registry.source).toBe(srv.url);
    expect(lf?.parts["email.transactional"]?.provenance).toBe(`registry:${srv.url}`);
    expect((await verifyRepo(repo)).ok).toBe(true);
    expect((await guardRepo(repo)).ok).toBe(true);

    // The flip works over the wire too.
    const flip = await upgradePart(repo, { name: "email.transactional", adapter: "postmark" });
    expect(flip.changed).toBe(true);
    expect((await verifyRepo(repo)).ok).toBe(true);
  });

  it("a tampered download is rejected by the manifest sha256 and nothing is installed", async () => {
    const srv = await serveRegistry((p) => p.endsWith("/adapters/resend/adapter.ts"));
    servers.push(srv);
    const repo = await makeApp(srv.url);

    await expect(
      addPart(repo, { name: "email.transactional", adapter: "resend" }),
    ).rejects.toThrow(/corrupted or tampered/);
    await expect(stat(path.join(repo, "parts/email.transactional"))).rejects.toThrow();
    const lf = await readLockfile(repo);
    expect(lf?.parts["email.transactional"]).toBeUndefined();
  });

  it("fails honestly when the URL is not a registry", async () => {
    const srv = await serveRegistry();
    servers.push(srv);
    await expect(openRegistry(`${srv.url}/no/such/prefix`)).rejects.toThrow(
      /Registry request failed: 404/,
    );
  });
});
