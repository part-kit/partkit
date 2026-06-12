/**
 * admin.crud — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 *
 * Schema-driven internal admin over OTHER parts' tables, driven entirely by their
 * declared data_ownership.reads (RFC 0004). Reads project only declared,
 * non-redacted columns through the SqlExecutor seam; writes dispatch to the
 * parts' public-export mutators (the app wires them). admin.crud imports nothing
 * from the parts it administers — it adapts at runtime from their contracts
 * (contract invariant 6). Importing this module performs no I/O.
 */
import { AdminError } from "./internal/errors";
import { buildGetSql, buildListSql } from "./internal/sql";
import type {
  Admin,
  AdminConfig,
  AdminRow,
  ContractLike,
  KeyInput,
  ListOptions,
  MutatorArgs,
  ResourceDeclaration,
  ResourceInfo,
  SqlExecutor,
} from "./internal/types";
import {
  buildOrderBy,
  orderedKeyValues,
  resolveResource,
  validateListOptions,
} from "./internal/validate";

export { AdminError } from "./internal/errors";
export type { AdminErrorCode } from "./internal/errors";
export type {
  Admin,
  AdminConfig,
  AdminRow,
  ColumnDescriptor,
  ContractLike,
  KeyInput,
  ListOptions,
  Mutator,
  MutatorArgs,
  MutatorRegistry,
  ReadDescriptor,
  ReadsMap,
  ResourceDeclaration,
  ResourceInfo,
  SqlExecutor,
} from "./internal/types";

/**
 * Extract the administered resources from a set of parsed part contracts (pure;
 * no I/O). A part with no `data_ownership.reads` contributes nothing (contract
 * invariant 3). The app loads its installed `parts/<name>/contract.json` and
 * passes them here (seams.md §1).
 */
export function collectReads(contracts: ContractLike[]): ResourceDeclaration[] {
  const out: ResourceDeclaration[] = [];
  for (const c of contracts) {
    const reads = c.data_ownership?.reads;
    if (reads !== undefined && Object.keys(reads).length > 0) {
      out.push({ part: c.part, reads });
    }
  }
  return out;
}

/**
 * Bind the admin operations to the declared resources, an optional read
 * executor, and the app-wired mutators. Constructing it performs no I/O and
 * never throws — declarations are validated, and the database touched, only when
 * a method runs (serverless-safe). Construct it per request with a request-scoped
 * `db` and `mutators`.
 */
export function admin(config: AdminConfig): Admin {
  return {
    resources: (): ResourceInfo[] => listResources(config),
    list: (table: string, opts?: ListOptions): Promise<AdminRow[]> =>
      listRows(config, table, opts ?? {}),
    get: (table: string, key: KeyInput): Promise<AdminRow | null> => getRow(config, table, key),
    create: (table: string, input: Record<string, unknown>): Promise<unknown> =>
      dispatch(config, table, "create", { input }),
    update: (table: string, key: KeyInput, patch: Record<string, unknown>): Promise<unknown> =>
      dispatch(config, table, "update", { key, patch }),
    remove: (table: string, key: KeyInput): Promise<unknown> =>
      dispatch(config, table, "delete", { key }),
  };
}

function requireDb(config: AdminConfig): SqlExecutor {
  if (config.db === undefined) {
    throw new AdminError("invalid_input", "admin reads require a database — set config.db");
  }
  return config.db;
}

function listResources(config: AdminConfig): ResourceInfo[] {
  const out: ResourceInfo[] = [];
  for (const r of config.resources) {
    for (const [table, descriptor] of Object.entries(r.reads)) {
      const readable = descriptor.columns.filter((c) => c.redact !== true);
      out.push({
        part: r.part,
        table,
        label: descriptor.label ?? table,
        primaryKey: Array.isArray(descriptor.primary_key)
          ? descriptor.primary_key
          : [descriptor.primary_key],
        columns: readable.map((c) => ({
          name: c.name,
          type: c.type,
          ...(c.label !== undefined ? { label: c.label } : {}),
          ...(c.references_capability !== undefined
            ? { referencesCapability: c.references_capability }
            : {}),
        })),
        actions: {
          create: Boolean(descriptor.mutations?.create),
          update: Boolean(descriptor.mutations?.update),
          delete: Boolean(descriptor.mutations?.delete),
        },
      });
    }
  }
  return out;
}

async function listRows(
  config: AdminConfig,
  table: string,
  opts: ListOptions,
): Promise<AdminRow[]> {
  const resource = resolveResource(config.resources, table); // throws unknown_resource
  if (resource.readable.length === 0) {
    throw new AdminError("invalid_contract", `${table} declares no readable (non-redacted) columns`);
  }
  const db = requireDb(config);
  const { limit, offset } = validateListOptions(opts);
  const orderBy = buildOrderBy(resource.descriptor.order_by, resource.readable);
  const sql = buildListSql(table, resource.readable, orderBy);
  let result: { rows: Record<string, unknown>[] };
  try {
    result = await db.query(sql, [limit, offset]);
  } catch (e) {
    throw new AdminError("storage", "admin read failed", { cause: e });
  }
  return result.rows;
}

async function getRow(
  config: AdminConfig,
  table: string,
  key: KeyInput,
): Promise<AdminRow | null> {
  const resource = resolveResource(config.resources, table); // throws unknown_resource
  if (resource.readable.length === 0) {
    throw new AdminError("invalid_contract", `${table} declares no readable (non-redacted) columns`);
  }
  const values = orderedKeyValues(key, resource.primaryKey); // throws invalid_input before any SQL
  const db = requireDb(config);
  const sql = buildGetSql(table, resource.readable, resource.primaryKey);
  let result: { rows: Record<string, unknown>[] };
  try {
    result = await db.query(sql, values);
  } catch (e) {
    throw new AdminError("storage", "admin read failed", { cause: e });
  }
  return result.rows[0] ?? null;
}

/**
 * The write boundary (contract invariant 4): a write is only ever the part's own
 * `mutations` export, called through the app-wired mutator. admin.crud issues NO
 * write SQL. A table with no mutation for the action is read-only; a mutator's
 * own typed errors propagate UNCHANGED, so the part's invariants (last-owner
 * guards, append-only triggers, …) still hold.
 */
async function dispatch(
  config: AdminConfig,
  table: string,
  action: "create" | "update" | "delete",
  args: MutatorArgs,
): Promise<unknown> {
  const resource = resolveResource(config.resources, table); // throws unknown_resource
  const exportName = resource.descriptor.mutations?.[action];
  if (exportName === undefined) {
    throw new AdminError(
      "read_only",
      `"${table}" has no "${action}" mutation — it is read-only in the admin`,
    );
  }
  if (args.key !== undefined) orderedKeyValues(args.key, resource.primaryKey); // validate key shape
  const fn = config.mutators?.[resource.part]?.[exportName];
  if (fn === undefined) {
    throw new AdminError(
      "no_mutator",
      `no mutator wired for ${resource.part}.${exportName} — provide config.mutators[${JSON.stringify(resource.part)}][${JSON.stringify(exportName)}]`,
    );
  }
  return await fn(args); // the part's own errors propagate, unwrapped
}
