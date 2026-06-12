import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { AttestationSchema, type Attestation } from "./attestation.js";
import { ContractSchema, type Contract } from "./contract.js";

/** The hosted registry (docs/03 §1: static repo + CDN, read over HTTPS). */
export const DEFAULT_REGISTRY = "https://registry.partkit.dev";

export const RegistryIndexSchema = z.object({
  registry_version: z.literal(1),
  parts: z.record(
    z.object({
      latest: z.string(),
      versions: z.array(z.string()).min(1),
      provides: z.array(z.string()),
    }),
  ),
});
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;

/** parts/<name>/<version>/manifest.json — the file list a static HTTP registry needs. */
export const ManifestSchema = z.object({
  manifest_version: z.literal(1),
  part: z.string(),
  version: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .min(1),
  attestations: z.array(z.string()).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export interface FetchedContent {
  /** Local directory holding the full registry-side part content (all adapters). */
  dir: string;
  cleanup(): Promise<void>;
}

/**
 * What every registry speaks — local directory or hosted HTTPS, one protocol
 * (docs/03 §2: the CLI is the reference implementation; private registries
 * speak the same API).
 */
export interface PartRegistry {
  readonly source: string;
  index(): Promise<RegistryIndex>;
  contract(name: string, version: string): Promise<Contract>;
  attestation(name: string, version: string, adapter: string | null): Promise<Attestation>;
  seams(name: string, version: string): Promise<string>;
  /** migrations/<from>-<to>/seam-changes.md of the target version, or null when unpublished. */
  seamChanges(name: string, fromVersion: string, toVersion: string): Promise<string | null>;
  capabilitySummary(capability: string): Promise<string | null>;
  fetchContent(name: string, version: string): Promise<FetchedContent>;
}

/** Route by scheme: https → hosted, anything else → local directory. */
export async function openRegistry(source: string): Promise<PartRegistry> {
  return /^https?:/i.test(source) ? HttpRegistry.open(source) : StaticRegistry.open(source);
}

/** The v0 local registry — a checkout of the registry directory. */
export class StaticRegistry implements PartRegistry {
  private constructor(readonly source: string) {}

  static async open(source: string): Promise<StaticRegistry> {
    if (/^https?:/i.test(source)) {
      throw new Error(`StaticRegistry reads local directories — use openRegistry() for ${source}.`);
    }
    try {
      await stat(path.join(source, "index.json"));
    } catch {
      throw new Error(`Not a registry: ${source} (missing index.json)`);
    }
    return new StaticRegistry(source);
  }

  async index(): Promise<RegistryIndex> {
    const raw = await readFile(path.join(this.source, "index.json"), "utf8");
    return RegistryIndexSchema.parse(JSON.parse(raw));
  }

  /** Registry-side part content (all adapters; pruned at vendor time). */
  partContentDir(name: string, version: string): string {
    return path.join(this.source, "parts", name, version, "part");
  }

  async contract(name: string, version: string): Promise<Contract> {
    const raw = await readFile(
      path.join(this.partContentDir(name, version), "contract.json"),
      "utf8",
    );
    return ContractSchema.parse(JSON.parse(raw));
  }

  async seams(name: string, version: string): Promise<string> {
    return readFile(path.join(this.partContentDir(name, version), "seams.md"), "utf8");
  }

  async seamChanges(name: string, fromVersion: string, toVersion: string): Promise<string | null> {
    try {
      return await readFile(
        path.join(
          this.partContentDir(name, toVersion),
          "migrations",
          `${fromVersion}-${toVersion}`,
          "seam-changes.md",
        ),
        "utf8",
      );
    } catch {
      return null;
    }
  }

  /** Capability summary from registry/capabilities/<name>/v1/capability.json, if present. */
  async capabilitySummary(capability: string): Promise<string | null> {
    try {
      const raw = await readFile(
        path.join(this.source, "capabilities", capability, "v1", "capability.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw) as { summary?: unknown };
      return typeof parsed.summary === "string" ? parsed.summary : null;
    } catch {
      return null;
    }
  }

  async fetchContent(name: string, version: string): Promise<FetchedContent> {
    const dir = this.partContentDir(name, version);
    try {
      await stat(dir);
    } catch {
      throw new Error(`${name}@${version} has no content at ${dir}`);
    }
    return { dir, cleanup: async () => {} };
  }

  async attestation(name: string, version: string, adapter: string | null): Promise<Attestation> {
    const file = `${adapter ?? "default"}.json`;
    const p = path.join(this.source, "parts", name, version, "attestations", file);
    let raw: string;
    try {
      raw = await readFile(p, "utf8");
    } catch {
      throw new Error(
        `No attestation for ${name}@${version} (adapter: ${adapter ?? "none"}) — ` +
          `unattested parts are not installable.`,
      );
    }
    return AttestationSchema.parse(JSON.parse(raw));
  }
}

const DOWNLOAD_CONCURRENCY = 6;

/**
 * The hosted registry over HTTPS. Contracts and manifests are immutable per
 * version, so responses cache for the process lifetime. Downloads are
 * verified file-by-file against the manifest's sha256 before vendorPart's
 * attestation content-hash seals the materialized tree — belt and suspenders.
 */
export class HttpRegistry implements PartRegistry {
  private readonly cache = new Map<string, Promise<unknown>>();

  private constructor(readonly source: string) {}

  static async open(source: string): Promise<HttpRegistry> {
    const reg = new HttpRegistry(source.replace(/\/+$/, ""));
    await reg.index(); // fail fast with an honest message
    return reg;
  }

  private url(...segments: string[]): string {
    return `${this.source}/${segments.join("/")}`;
  }

  private async fetchBytes(url: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(
        `Registry unreachable: ${url} (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    if (!res.ok) {
      throw new Error(`Registry request failed: ${res.status} ${res.statusText} for ${url}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (p === undefined) {
      p = load().catch((e: unknown) => {
        this.cache.delete(key); // never cache failures
        throw e;
      });
      this.cache.set(key, p);
    }
    return p;
  }

  async index(): Promise<RegistryIndex> {
    // The index changes as parts publish — fetched fresh, not cached.
    const raw = await this.fetchBytes(this.url("index.json"));
    return RegistryIndexSchema.parse(JSON.parse(raw.toString("utf8")));
  }

  async contract(name: string, version: string): Promise<Contract> {
    return this.cached(`contract:${name}@${version}`, async () => {
      const raw = await this.fetchBytes(this.url("parts", name, version, "part", "contract.json"));
      return ContractSchema.parse(JSON.parse(raw.toString("utf8")));
    });
  }

  async seams(name: string, version: string): Promise<string> {
    return this.cached(`seams:${name}@${version}`, async () => {
      const raw = await this.fetchBytes(this.url("parts", name, version, "part", "seams.md"));
      return raw.toString("utf8");
    });
  }

  async seamChanges(name: string, fromVersion: string, toVersion: string): Promise<string | null> {
    try {
      const raw = await this.fetchBytes(
        this.url(
          "parts", name, toVersion, "part", "migrations",
          `${fromVersion}-${toVersion}`, "seam-changes.md",
        ),
      );
      return raw.toString("utf8");
    } catch {
      return null;
    }
  }

  async capabilitySummary(capability: string): Promise<string | null> {
    return this.cached(`cap:${capability}`, async () => {
      try {
        const raw = await this.fetchBytes(
          this.url("capabilities", capability, "v1", "capability.json"),
        );
        const parsed = JSON.parse(raw.toString("utf8")) as { summary?: unknown };
        return typeof parsed.summary === "string" ? parsed.summary : null;
      } catch {
        return null;
      }
    });
  }

  async attestation(name: string, version: string, adapter: string | null): Promise<Attestation> {
    const file = `${adapter ?? "default"}.json`;
    let raw: Buffer;
    try {
      raw = await this.fetchBytes(this.url("parts", name, version, "attestations", file));
    } catch {
      throw new Error(
        `No attestation for ${name}@${version} (adapter: ${adapter ?? "none"}) — ` +
          `unattested parts are not installable.`,
      );
    }
    return AttestationSchema.parse(JSON.parse(raw.toString("utf8")));
  }

  async manifest(name: string, version: string): Promise<Manifest> {
    return this.cached(`manifest:${name}@${version}`, async () => {
      const raw = await this.fetchBytes(this.url("parts", name, version, "manifest.json"));
      return ManifestSchema.parse(JSON.parse(raw.toString("utf8")));
    });
  }

  async fetchContent(name: string, version: string): Promise<FetchedContent> {
    const manifest = await this.manifest(name, version);
    const dir = await mkdtemp(path.join(tmpdir(), "partkit-fetch-"));
    const cleanup = async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
    };
    const queue = [...manifest.files];
    let failed = false;
    const workers = Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
      for (;;) {
        const file = queue.shift();
        if (file === undefined || failed) return;
        if (file.path.split("/").some((seg) => seg === ".." || seg === "")) {
          throw new Error(`Manifest path escapes the part directory: ${file.path}`);
        }
        const bytes = await this.fetchBytes(
          this.url("parts", name, version, "part", ...file.path.split("/")),
        );
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== file.sha256) {
          throw new Error(
            `Download of ${file.path} hashes to ${digest}, manifest says ${file.sha256} — ` +
              `corrupted or tampered transfer; nothing was installed.`,
          );
        }
        const abs = path.join(dir, ...file.path.split("/"));
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, bytes);
      }
    });
    // Settle every worker before any cleanup — a half-written tree must never
    // be rm'd under a still-writing worker, and rm noise must never mask the
    // real failure.
    const settled = await Promise.all(
      workers.map(async (w) =>
        w.then(
          () => null,
          (e: unknown) => {
            failed = true;
            return e;
          },
        ),
      ),
    );
    const firstError = settled.find((e) => e !== null);
    if (firstError !== undefined && firstError !== null) {
      try {
        await cleanup();
      } catch {
        // temp dir leak beats masking the real error
      }
      throw firstError;
    }
    return { dir, cleanup };
  }
}
