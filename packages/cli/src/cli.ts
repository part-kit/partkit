#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";
import { Command } from "commander";
import {
  DEFAULT_REGISTRY,
  GUARD_MESSAGE,
  MIGRATIONS_TABLE,
  addParts,
  auditRepo,
  ejectPart,
  guardRepo,
  initRepo,
  openRegistry,
  planMigrations,
  readLockfile,
  resolvePlan,
  runMigrations,
  upgradePart,
  verifyRepo,
  type AuditCheck,
  type SqlExecutor,
} from "@part-kit/core";

function fail(e: unknown): never {
  console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const program = new Command();
program
  .name("partkit")
  .description("Verified, attested standard parts for AI coding agents")
  .version("0.2.1");

program
  .command("init")
  .description("Install the boundary guard (pre-commit + CI), parts.lock, and AGENTS.md")
  .option("--registry <source>", "registry source (local path until the hosted registry is live)", DEFAULT_REGISTRY)
  .action(async (o: { registry: string }) => {
    try {
      const res = await initRepo(process.cwd(), { registrySource: o.registry });
      for (const c of res.created) console.log(`  + ${c}`);
      for (const s of res.skipped) console.log(`  = ${s} (already present)`);
      for (const w of res.warnings) console.log(`  ! ${w}`);
      console.log("\nDone. Agents that open this repo will read AGENTS.md and learn the rules.");
    } catch (e) {
      fail(e);
    }
  });

program
  .command("plan")
  .description("Resolve capabilities into a deterministic install plan (the resolver, docs/03 §4)")
  .argument("<capabilities...>", "capability names, e.g. email.transactional webhooks.ingest")
  .option("--registry <source>", "registry source (default: parts.lock's, else the hosted registry)")
  .option("--allow-community", "accept community-tier adapters")
  .option("--json", "print the raw plan JSON")
  .action(
    async (
      capabilities: string[],
      o: { registry?: string; allowCommunity?: boolean; json?: boolean },
    ) => {
      try {
        const lf = await readLockfile(process.cwd());
        const registry = await openRegistry(o.registry ?? lf?.registry.source ?? DEFAULT_REGISTRY);
        const plan = await resolvePlan(registry, {
          capabilities,
          lockfile: lf,
          ...(o.allowCommunity === true && { policy: { trust: "allow-community" as const } }),
        });
        if (o.json === true) {
          console.log(JSON.stringify(plan, null, 2));
          return;
        }
        for (const s of plan.already_satisfied) {
          console.log(`= ${s.capability} already provided by ${s.part}@${s.version}`);
        }
        for (const e of plan.install_order) {
          const adapter =
            e.adapter !== null
              ? ` --adapter=${e.adapter}`
              : e.adapter_choices !== undefined
                ? ` --adapter=${e.adapter_choices.join("|")}`
                : "";
          console.log(`→ partkit add ${e.part}${adapter}   (${e.reason})`);
        }
        if (plan.env_required.length > 0) console.log(`env: ${plan.env_required.join(", ")}`);
        console.log(`migrations: ${plan.migrations}`);
        for (const s of plan.seams_to_write) console.log(`seam: ${s}`);
        for (const n of plan.notes) console.log(`note: ${n}`);
        for (const r of plan.rules) console.log(`rule: ${r}`);
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command("add")
  .description("Vendor parts, packs, or part:adapter specs — resolves order, pulls requires, skips installed")
  .argument(
    "<targets...>",
    "parts, packs, or part[@version][:adapter] — e.g. saas, email.transactional:postmark",
  )
  .option("--adapter <name>", "adapter for a single part (or use part:adapter)")
  .option("--part-version <semver>", "version for a single part (or use part@version)")
  .option("--registry <source>", "override the registry recorded in parts.lock")
  .option("--allow-community", "accept community-tier adapters (conformance not run in our CI)")
  .action(
    async (
      targets: string[],
      o: { adapter?: string; partVersion?: string; registry?: string; allowCommunity?: boolean },
    ) => {
      try {
        // Back-compat: --adapter / --part-version apply to a single target.
        let raw = targets;
        if (o.adapter !== undefined || o.partVersion !== undefined) {
          if (targets.length !== 1) {
            throw new Error(
              "--adapter / --part-version apply to one part; for several, use part@version:adapter syntax.",
            );
          }
          let t = targets[0]!;
          if (o.partVersion !== undefined) t = `${t}@${o.partVersion}`;
          if (o.adapter !== undefined) t = `${t}:${o.adapter}`;
          raw = [t];
        }

        const res = await addParts(process.cwd(), {
          targets: raw,
          ...(o.registry !== undefined && { registrySource: o.registry }),
          ...(o.allowCommunity !== undefined && { allowCommunity: o.allowCommunity }),
        });

        for (const pk of res.packs) {
          console.log(`▪ pack ${pk.pack} — ${pk.capabilities.length} capabilities`);
        }
        for (const s of res.alreadySatisfied) {
          console.log(`= ${s.capability} already provided by ${s.part}@${s.version}`);
        }
        for (const r of res.installed) {
          const adapterNote = r.adapter !== null ? ` (adapter: ${r.adapter})` : "";
          console.log(`✔ ${r.name}@${r.version}${adapterNote} vendored into parts/`);
          const addedDeps = Object.entries(r.npmDependencies.added);
          if (addedDeps.length > 0) {
            console.log(`  npm: + ${addedDeps.map(([n, v]) => `${n}@${v}`).join(", ")}`);
          }
          for (const w of r.warnings) console.log(`  ! ${w}`);
        }

        if (res.installed.length > 0) {
          if (res.envRequired.length > 0) {
            console.log(`\nenv: fill in ${res.envRequired.join(", ")} (.env.example scaffolded)`);
          }
          console.log(`migrations: ${res.migrations}`);
          console.log("\nNow write the seams (the only code you touch):");
          for (const s of res.seams) console.log(`  - ${s}`);
        }
        for (const n of res.notes) console.log(`note: ${n}`);

        if (res.failed !== null) {
          console.error(`\n✖ ${res.failed.part}: ${res.failed.error}`);
          if (res.notLanded.length > 0) {
            console.error(`  not attempted: ${res.notLanded.join(", ")} — fix the above and re-run to resume.`);
          }
          process.exit(1);
        }
        if (res.installed.length === 0 && res.packs.length === 0) {
          console.log("Nothing to install — everything requested is already in parts.lock.");
        }
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command("verify")
  .description("Verify attestation integrity (hard fail) and freshness (warn; --strict to fail)")
  .option("--strict", "treat staleness and unsigned dev attestations as failures")
  .action(async (o: { strict?: boolean }) => {
    try {
      const res = await verifyRepo(process.cwd(), { strict: o.strict === true });
      for (const f of res.findings) {
        const icon = f.level === "fail" ? "✖" : "⚠";
        console.log(`${icon} [${f.code}] ${f.part}: ${f.message}`);
      }
      if (!res.ok) {
        console.error("\npartkit verify failed.");
        process.exit(1);
      }
      const warnNote = res.findings.length > 0 ? " (with warnings)" : "";
      console.log(`✔ ${res.checked} part(s) verified${warnNote}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("audit")
  .description("Did this repo respect its contracts? Boundary + attestations + routes/env/sprawl in one pass")
  .option("--strict", "treat staleness and unsigned dev attestations as failures")
  .option("--json", "print the raw audit result as JSON")
  .action(async (o: { strict?: boolean; json?: boolean }) => {
    try {
      const res = await auditRepo(process.cwd(), { strict: o.strict === true });
      if (o.json === true) {
        console.log(JSON.stringify(res, null, 2));
        if (!res.ok) process.exit(1);
        return;
      }
      const icon = (l: AuditCheck["level"]): string =>
        l === "fail" ? "✖" : l === "warn" ? "⚠" : "✔";
      console.log(`PARTKIT AUDIT · ${res.parts} part(s) · ${res.checks.length} checks\n`);
      for (const c of res.checks) {
        console.log(`  ${icon(c.level)} ${c.key.padEnd(13)} ${c.summary}`);
        for (const f of c.findings) {
          const mark = f.level === "fail" ? "✖" : f.level === "warn" ? "⚠" : "·";
          console.log(`      ${mark} ${f.message}`);
          if (f.fix !== undefined) console.log(`        → ${f.fix}`);
        }
      }
      const { pass, warn, fail } = res.counts;
      console.log(`\n${pass} clean · ${warn} warning(s) · ${fail} failure(s)`);
      if (!res.ok) {
        console.error("\npartkit audit failed — a contract was not respected.");
        process.exit(1);
      }
      console.log(
        "Boundary intact, attestations verified. Warnings are guidance, not gates" +
          (warn > 0 ? " — each lists the seam-side fix." : "."),
      );
    } catch (e) {
      fail(e);
    }
  });

program
  .command("upgrade")
  .description("Upgrade a part's version and/or flip its adapter — interiors change mechanically, you get only the seam changes")
  .argument("<part>", "installed part name")
  .option("--adapter <name>", "switch to this adapter (the one-commit vendor flip)")
  .option("--part-version <semver>", "target version (default: registry latest)")
  .option("--registry <source>", "override the registry recorded in parts.lock")
  .option("--allow-community", "accept community-tier adapters")
  .action(
    async (
      part: string,
      o: { adapter?: string; partVersion?: string; registry?: string; allowCommunity?: boolean },
    ) => {
      try {
        const res = await upgradePart(process.cwd(), {
          name: part,
          ...(o.adapter !== undefined && { adapter: o.adapter }),
          ...(o.partVersion !== undefined && { version: o.partVersion }),
          ...(o.registry !== undefined && { registrySource: o.registry }),
          ...(o.allowCommunity !== undefined && { allowCommunity: o.allowCommunity }),
        });
        if (!res.changed) {
          console.log(`= ${res.name} unchanged (${res.to.version}, adapter: ${res.to.adapter ?? "none"})`);
        } else {
          const flip = res.from.adapter !== res.to.adapter ? ` · adapter ${res.from.adapter ?? "none"} → ${res.to.adapter ?? "none"}` : "";
          console.log(`✔ ${res.name} ${res.from.version} → ${res.to.version}${flip}`);
          const added = Object.entries(res.npmDependencies.added);
          if (added.length > 0) {
            console.log(`  npm: added ${added.map(([n, r]) => `${n}@${r}`).join(", ")} to package.json — run your package manager's install`);
          }
          if (res.seamChanges !== null) {
            console.log(`\nSeam changes you must make:\n${res.seamChanges}`);
          }
        }
        for (const w of res.warnings) console.log(`  ! ${w}`);
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command("eject")
  .description("Sanctioned exit: move a part out of the boundary, void its attestation — you own the code from here")
  .argument("<part>", "installed part name")
  .option("--to <dir>", "destination directory relative to the repo root (default: ejected/<part>)")
  .action(async (part: string, o: { to?: string }) => {
    try {
      const res = await ejectPart(process.cwd(), {
        name: part,
        ...(o.to !== undefined && { to: o.to }),
      });
      console.log(`✔ ${res.name} ejected: ${res.from} → ${res.to}`);
      for (const w of res.warnings) console.log(`  ! ${w}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("migrate")
  .description(`Apply pending part-owned database migrations (recorded in ${MIGRATIONS_TABLE})`)
  .option("--dry-run", "print the plan without applying anything")
  .option("--database-url <url>", "Postgres connection string (default: $DATABASE_URL)")
  .action(async (o: { dryRun?: boolean; databaseUrl?: string }) => {
    try {
      const url = o.databaseUrl ?? process.env.DATABASE_URL;
      if (url === undefined || url === "") {
        throw new Error("DATABASE_URL is not set — export it or pass --database-url.");
      }
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const executor: SqlExecutor = {
        query: async (sql, params) => {
          const res = await client.query(sql, params === undefined ? undefined : [...params]);
          return { rows: res.rows as Record<string, unknown>[] };
        },
      };
      try {
        if (o.dryRun === true) {
          const plan = await planMigrations(process.cwd(), executor);
          for (const m of plan.pending) {
            console.log(`  → ${m.part}: ${m.name}${m.transactional ? "" : " (no-transaction)"}`);
          }
          for (const r of plan.orphaned) {
            console.log(`  ! ledger row for uninstalled part ${r.part} (${r.name}) — left untouched`);
          }
          console.log(
            plan.pending.length === 0
              ? `✔ database is up to date (${plan.applied.length} migration(s) applied)`
              : `${plan.pending.length} pending, ${plan.applied.length} applied — run without --dry-run to apply`,
          );
        } else {
          const res = await runMigrations(process.cwd(), executor);
          for (const m of res.applied) console.log(`  ✔ ${m.part}: ${m.name}`);
          for (const r of res.orphaned) {
            console.log(`  ! ledger row for uninstalled part ${r.part} (${r.name}) — left untouched`);
          }
          console.log(
            res.applied.length === 0
              ? `✔ database is up to date (${res.alreadyApplied} migration(s) applied)`
              : `✔ applied ${res.applied.length} migration(s); ledger: ${MIGRATIONS_TABLE}`,
          );
        }
      } finally {
        await client.end();
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("guard")
  .description("Boundary guard: fail if parts/** no longer matches parts.lock")
  .option("--staged", "pre-commit mode: skip quickly when nothing under parts/ is staged")
  .action(async (o: { staged?: boolean }) => {
    try {
      if (o.staged === true) {
        const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
          encoding: "utf8",
        });
        const touched = out
          .split("\n")
          .filter((l) => l.startsWith("parts/") || l === "parts.lock");
        if (touched.length === 0) return;
      }
      const res = await guardRepo(process.cwd());
      if (!res.ok) {
        for (const p of res.problems) console.error(`✖ ${p}`);
        console.error(`\n${GUARD_MESSAGE}`);
        process.exit(1);
      }
      console.log("✔ part boundary intact");
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync(process.argv).catch(fail);
