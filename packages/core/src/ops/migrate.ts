import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { LOCKFILE_NAME, readLockfile } from "../lockfile.js";

/**
 * Minimal slice of a Postgres client (node-postgres `Client#query` shape).
 * Core stays driver-free: the CLI hands in a real client, tests hand in fakes.
 */
export interface SqlExecutor {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export const MIGRATIONS_TABLE = "_part_migrations";

/**
 * First line that opts a migration out of its per-migration transaction
 * (concurrent index builds etc. — docs/02 §6). Such a migration must document
 * a resume path in its part's SPEC.md.
 */
export const NO_TRANSACTION_DIRECTIVE = "-- partkit:no-transaction";

/** Session advisory lock so concurrent deploys serialize on the ledger. */
const MIGRATE_LOCK_KEY = 0x7041726b;

/** `NNN-description.sql`, sequentially numbered from 001 with no gaps. */
const MIGRATION_FILE_RE = /^(\d+)-[A-Za-z0-9._-]+\.sql$/;

export interface MigrationFile {
  part: string;
  seq: number;
  name: string;
  sha256: string;
  sql: string;
  transactional: boolean;
}

export interface LedgerRow {
  part: string;
  seq: number;
  name: string;
  sha256: string;
}

export interface MigratePlan {
  /** Ledger rows verified byte-identical against the local files. */
  applied: LedgerRow[];
  /** Files to apply, in execution order (parts alphabetical, seq ascending). */
  pending: MigrationFile[];
  /** Ledger rows for parts not in parts.lock — never touched, surfaced for honesty. */
  orphaned: LedgerRow[];
}

export interface MigrateResult {
  applied: MigrationFile[];
  alreadyApplied: number;
  orphaned: LedgerRow[];
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadMigrationFiles(
  repoRoot: string,
  parts: readonly string[],
): Promise<Map<string, MigrationFile[]>> {
  const out = new Map<string, MigrationFile[]>();
  for (const part of parts) {
    const dir = path.join(repoRoot, "parts", part, "migrations");
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      entries = [];
    }
    const files: MigrationFile[] = [];
    for (const entry of entries) {
      if (entry === ".gitkeep" || entry === ".DS_Store") continue;
      const m = MIGRATION_FILE_RE.exec(entry);
      if (!m) {
        throw new Error(
          `${part}: unrecognized file in migrations/: ${entry} — migrations are NNN-description.sql`,
        );
      }
      const bytes = await readFile(path.join(dir, entry));
      const sql = bytes.toString("utf8");
      files.push({
        part,
        seq: Number.parseInt(m[1]!, 10),
        name: entry,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sql,
        transactional: sql.trimStart().split("\n", 1)[0]?.trim() !== NO_TRANSACTION_DIRECTIVE,
      });
    }
    files.sort((a, b) => a.seq - b.seq);
    files.forEach((f, i) => {
      if (f.seq !== i + 1) {
        throw new Error(
          `${part}: migrations must be sequentially numbered from 001 with no gaps or duplicates — ${f.name} is at position ${i + 1}`,
        );
      }
    });
    if (files.length > 0) out.set(part, files);
  }
  return out;
}

async function readLedger(executor: SqlExecutor): Promise<LedgerRow[]> {
  const reg = await executor.query("SELECT to_regclass($1) AS t", [MIGRATIONS_TABLE]);
  if (reg.rows[0]?.["t"] == null) return [];
  const res = await executor.query(
    `SELECT part, seq, name, sha256 FROM ${MIGRATIONS_TABLE} ORDER BY part, seq`,
  );
  return res.rows.map((r) => ({
    part: String(r["part"]),
    seq: Number(r["seq"]),
    name: String(r["name"]),
    sha256: String(r["sha256"]),
  }));
}

/**
 * Compute the migration plan: which ledger rows are verified, which files are
 * pending. Read-only (works against a database that has no ledger table yet),
 * so `--dry-run` is honest. Hard-fails on any divergence between ledger and
 * files — an applied migration whose bytes changed is tampering, not drift
 * (docs/02 §6: part migrations are forward-only and interiors are read-only).
 */
export async function planMigrations(
  repoRoot: string,
  executor: SqlExecutor,
): Promise<MigratePlan> {
  const lf = await readLockfile(repoRoot);
  if (!lf) throw new Error(`No ${LOCKFILE_NAME} found — run \`partkit init\` first.`);
  const installed = Object.keys(lf.parts).sort();
  const local = await loadMigrationFiles(repoRoot, installed);

  const ledgerByPart = new Map<string, LedgerRow[]>();
  const orphaned: LedgerRow[] = [];
  for (const row of await readLedger(executor)) {
    if (!lf.parts[row.part]) {
      orphaned.push(row);
      continue;
    }
    const rows = ledgerByPart.get(row.part);
    if (rows) rows.push(row);
    else ledgerByPart.set(row.part, [row]);
  }

  const applied: LedgerRow[] = [];
  const pending: MigrationFile[] = [];
  const parts = [...new Set([...local.keys(), ...ledgerByPart.keys()])].sort();
  for (const part of parts) {
    const files = local.get(part) ?? [];
    const rows = ledgerByPart.get(part) ?? [];
    rows.forEach((row, i) => {
      if (row.seq !== i + 1) {
        throw new Error(
          `${part}: the ${MIGRATIONS_TABLE} ledger is not contiguous (row ${row.name} has seq ${row.seq} at position ${i + 1}) — the ledger was edited by hand; repair it before migrating.`,
        );
      }
    });
    if (rows.length > files.length) {
      throw new Error(
        `${part}: the database has ${rows.length} applied migrations but only ${files.length} exist in parts/${part}/migrations/ — this checkout is older than the database. Update the part, never the ledger.`,
      );
    }
    for (const row of rows) {
      const f = files[row.seq - 1]!;
      if (f.name !== row.name || f.sha256 !== row.sha256) {
        throw new Error(
          `${part}: applied migration ${row.name} no longer matches parts/${part}/migrations/${f.name} (ledger sha256 ${row.sha256}, local ${f.sha256}). Part interiors are read-only — restore with \`git checkout HEAD -- parts/\`.`,
        );
      }
      applied.push(row);
    }
    pending.push(...files.slice(rows.length));
  }
  return { applied, pending, orphaned };
}

async function recordApplied(executor: SqlExecutor, mig: MigrationFile): Promise<void> {
  await executor.query(
    `INSERT INTO ${MIGRATIONS_TABLE} (part, seq, name, sha256) VALUES ($1, $2, $3, $4)`,
    [mig.part, mig.seq, mig.name, mig.sha256],
  );
}

/**
 * Apply every pending migration, one transaction per migration, recording each
 * in the `_part_migrations` ledger (docs/02 §6). Cross-part order is
 * alphabetical and irrelevant by design — parts touch only their own tables.
 */
export async function runMigrations(
  repoRoot: string,
  executor: SqlExecutor,
): Promise<MigrateResult> {
  await executor.query(`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`);
  try {
    const plan = await planMigrations(repoRoot, executor);
    if (plan.pending.length > 0) {
      await executor.query(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  part       text        NOT NULL,
  seq        integer     NOT NULL,
  name       text        NOT NULL,
  sha256     text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (part, seq)
)`,
      );
    }
    const applied: MigrationFile[] = [];
    for (const mig of plan.pending) {
      if (mig.transactional) {
        await executor.query("BEGIN");
        try {
          await executor.query(mig.sql);
          await recordApplied(executor, mig);
          await executor.query("COMMIT");
        } catch (e) {
          await executor.query("ROLLBACK");
          throw new Error(
            `${mig.part}: migration ${mig.name} failed and was rolled back; ` +
              `${applied.length} earlier migration(s) from this run remain applied (one transaction per migration). Cause: ${msg(e)}`,
          );
        }
      } else {
        try {
          await executor.query(mig.sql);
        } catch (e) {
          throw new Error(
            `${mig.part}: non-transactional migration ${mig.name} failed partway — it declared ${NO_TRANSACTION_DIRECTIVE} and cannot be rolled back automatically. Follow its resume path in parts/${mig.part}/SPEC.md, then re-run \`partkit migrate\`. Cause: ${msg(e)}`,
          );
        }
        try {
          await recordApplied(executor, mig);
        } catch (e) {
          throw new Error(
            `${mig.part}: ${mig.name} ran but recording it in ${MIGRATIONS_TABLE} failed — the ledger is behind the database, and re-running will re-execute this migration (it must be resumable, which ${NO_TRANSACTION_DIRECTIVE} migrations declare). Cause: ${msg(e)}`,
          );
        }
      }
      applied.push(mig);
    }
    return { applied, alreadyApplied: plan.applied.length, orphaned: plan.orphaned };
  } finally {
    try {
      await executor.query(`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`);
    } catch {
      // Session end releases the advisory lock; never mask the real error.
    }
  }
}
