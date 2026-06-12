import { createHash } from "node:crypto";
import semver from "semver";
import { capabilityOf, effectiveNpmDependencies, type Contract } from "../contract.js";
import type { PartRegistry } from "../registry.js";

/**
 * The resolver (docs/03 §4). Deterministic: same inputs → same plan, always.
 * Conflicts fail loudly with an agent-readable explanation — never auto-fudge.
 * The normative response shape is docs/06-agent-walkthrough.md step 2.
 */

export interface ResolveInput {
  /** Capability names, bare (`billing.subscription`) or pinned (`billing.subscription@1`). */
  capabilities: string[];
  /** The repo's current parts.lock content ({} or null when fresh). */
  lockfile?: {
    parts?: Record<string, { version: string; provides: string[] }> | undefined;
  } | null;
  /** Stack constraints: `{ node: "22", framework: "next@16", db: "postgres" }`. */
  constraints?: Record<string, string>;
  policy?: { trust?: "attested-only" | "allow-community" | undefined };
}

export interface PlanEntry {
  part: string;
  version: string;
  adapter: string | null;
  /** Present when policy cannot decide — pick one at `partkit add --adapter=…`. */
  adapter_choices?: string[];
  reason: string;
  /** RFC 0001: packages `partkit add` will merge into the app's package.json. */
  npm_dependencies?: Record<string, string>;
}

export interface ResolvePlan {
  plan_id: string;
  install_order: PlanEntry[];
  already_satisfied: { capability: string; part: string; version: string }[];
  env_required: string[];
  migrations: string;
  seams_to_write: string[];
  rules: string[];
  notes: string[];
}

/** Travels with every plan, not only with the skill (docs/03 §3). */
export const NO_EDIT_RULE =
  "Do not edit parts/** — interiors are attested. Write only the seams listed above. " +
  "Each part's seams.md has type signatures and examples.";

interface Candidate {
  part: string;
  version: string;
  contract: Contract;
  providesMajor: Map<string, number>;
  reasons: string[];
  requiresEdges: string[]; // capability names
}

function parseCapability(raw: string): { capability: string; major: number | null } {
  const at = raw.indexOf("@");
  if (at === -1) return { capability: raw, major: null };
  return { capability: raw.slice(0, at), major: Number.parseInt(raw.slice(at + 1), 10) };
}

/** `{ framework: "next@16", db: "postgres" }` → `{ next: "16", postgres: "postgres" }`. */
function normalizeConstraints(constraints: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(constraints)) {
    if (key === "framework" || key === "db") {
      const at = value.indexOf("@");
      if (at === -1) out[value] = value;
      else out[value.slice(0, at)] = value.slice(at + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function resolvePlan(
  registry: PartRegistry,
  input: ResolveInput,
): Promise<ResolvePlan> {
  const idx = await registry.index();
  const trust = input.policy?.trust ?? "attested-only";
  const constraints = normalizeConstraints(input.constraints ?? {});
  const notes: string[] = [];

  // capability → provider in the registry (v0: one provider per capability).
  const providers = new Map<string, { part: string; major: number }>();
  for (const [part, meta] of Object.entries(idx.parts)) {
    for (const p of meta.provides) {
      const major = Number.parseInt(p.slice(p.indexOf("@") + 1), 10);
      providers.set(capabilityOf(p), { part, major });
    }
  }

  // capability → already-installed provider from the lockfile (anti-sprawl).
  const installed = new Map<string, { part: string; version: string }>();
  for (const [part, entry] of Object.entries(input.lockfile?.parts ?? {})) {
    for (const p of entry.provides) {
      installed.set(capabilityOf(p), { part, version: entry.version });
    }
  }

  const candidates = new Map<string, Candidate>(); // by part name
  const alreadySatisfied: ResolvePlan["already_satisfied"] = [];
  const seenCaps = new Set<string>();

  async function require(rawCap: string, reason: string): Promise<void> {
    const { capability, major } = parseCapability(rawCap);
    const have = installed.get(capability);
    if (have !== undefined) {
      if (!seenCaps.has(capability)) {
        seenCaps.add(capability);
        alreadySatisfied.push({ capability, part: have.part, version: have.version });
      }
      return;
    }
    const provider = providers.get(capability);
    if (provider === undefined) {
      const known = [...providers.keys()].sort().join(", ") || "(registry is empty)";
      throw new Error(
        `No part provides the capability "${capability}". Capabilities in this registry: ${known}. ` +
          `New capabilities enter the namespace by RFC (docs/02 §3).`,
      );
    }
    if (major !== null && provider.major < major) {
      throw new Error(
        `${capability}@${major} was requested but ${provider.part} provides ${capability}@${provider.major} — ` +
          `no compatible provider exists; do not fudge majors.`,
      );
    }
    const existing = candidates.get(provider.part);
    if (existing !== undefined) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    const meta = idx.parts[provider.part]!;
    const contract = await registry.contract(provider.part, meta.latest);

    // Platform vs constraints — only judge what both sides state and semver
    // can parse; never fail on what cannot be evaluated.
    for (const [key, range] of Object.entries(contract.platform)) {
      const want = constraints[key];
      if (want === undefined) continue;
      const coerced = semver.coerce(want);
      if (coerced === null || semver.validRange(range) === null) continue;
      if (!semver.satisfies(coerced, range)) {
        throw new Error(
          `${provider.part} requires ${key} ${range} but the repo constraint is ${key}=${want} — ` +
            `platform conflict; the part cannot be installed here.`,
        );
      }
    }

    const providesMajor = new Map<string, number>();
    for (const p of contract.provides) {
      providesMajor.set(capabilityOf(p), Number.parseInt(p.slice(p.indexOf("@") + 1), 10));
    }
    const cand: Candidate = {
      part: provider.part,
      version: meta.latest,
      contract,
      providesMajor,
      reasons: [reason],
      requiresEdges: [],
    };
    candidates.set(provider.part, cand);
    for (const req of contract.requires) {
      const reqCap = req.slice(0, req.indexOf(">="));
      const reqMajor = Number.parseInt(req.slice(req.indexOf(">=") + 2), 10);
      cand.requiresEdges.push(reqCap);
      await require(`${reqCap}@${reqMajor}`, `required by ${provider.part}`);
    }
  }

  for (const cap of input.capabilities) {
    await require(cap, "requested");
  }

  // Topological order, requires first; alphabetical tie-break for determinism.
  const ordered: Candidate[] = [];
  const placed = new Set<string>();
  const pending = [...candidates.values()].sort((a, b) => a.part.localeCompare(b.part));
  while (pending.length > 0) {
    const ready = pending.filter((c) =>
      c.requiresEdges.every((cap) => {
        const dep = providers.get(cap)?.part;
        return dep === undefined || placed.has(dep) || installed.has(cap) || dep === c.part;
      }),
    );
    if (ready.length === 0) {
      throw new Error(
        `Capability requirement cycle among: ${pending.map((c) => c.part).join(", ")} — refusing to guess an order.`,
      );
    }
    for (const c of ready) {
      ordered.push(c);
      placed.add(c.part);
      pending.splice(pending.indexOf(c), 1);
    }
  }

  const installOrder: PlanEntry[] = [];
  const envRequired: string[] = [];
  const seams: string[] = [];
  let tableOwners = 0;

  for (const c of ordered) {
    const installable = c.contract.adapters.filter(
      (a) => a.status === "attested" || (a.status === "community" && trust === "allow-community"),
    );
    if (c.contract.adapters.length > 0 && installable.length === 0) {
      throw new Error(
        `${c.part} has no ${trust === "attested-only" ? "attested" : "installable"} adapter ` +
          `(available: ${c.contract.adapters.map((a) => `${a.name} (${a.status})`).join(", ")}). ` +
          `Set policy.trust="allow-community" to accept community tier.`,
      );
    }
    const adapter = installable.length === 1 ? installable[0]!.name : null;
    if (installable.length > 1) {
      notes.push(
        `${c.part}: choose an adapter at add time — partkit add ${c.part} --adapter=${installable
          .map((a) => a.name)
          .sort()
          .join("|")}`,
      );
    }
    const entry: PlanEntry = {
      part: c.part,
      version: c.version,
      adapter,
      reason: c.reasons.sort().join("; "),
    };
    if (installable.length > 1) {
      entry.adapter_choices = installable.map((a) => a.name).sort();
    }
    const deps = effectiveNpmDependencies(c.contract, adapter);
    if (Object.keys(deps).length > 0) entry.npm_dependencies = deps;
    installOrder.push(entry);

    for (const key of Object.keys(c.contract.env)) {
      if (!envRequired.includes(key)) envRequired.push(key);
    }
    if (c.contract.data_ownership !== undefined) tableOwners += 1;

    const mounts = c.contract.interface.http_routes.map(
      (r) => `mount ${r.route} (one-line re-export of ${r.export})`,
    );
    seams.push(
      mounts.length > 0
        ? `${c.part}: ${mounts.join("; ")}; details: parts/${c.part}/seams.md`
        : `${c.part}: parts/${c.part}/seams.md (sufficient alone)`,
    );
  }

  const planId = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        capabilities: [...input.capabilities].sort(),
        constraints,
        trust,
        installed: [...installed.entries()].sort(([a], [b]) => a.localeCompare(b)),
        resolved: installOrder.map((e) => `${e.part}@${e.version}:${e.adapter ?? "-"}`),
      }),
    )
    .digest("hex")}`;

  return {
    plan_id: planId,
    install_order: installOrder,
    already_satisfied: alreadySatisfied,
    env_required: envRequired,
    migrations:
      tableOwners > 0
        ? `${tableOwners} part(s) own tables — run \`partkit migrate\` after add (ledger: _part_migrations)`
        : "no part-owned tables in this plan",
    seams_to_write: seams,
    rules: [NO_EDIT_RULE],
    notes,
  };
}
