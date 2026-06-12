/**
 * The driver-free database seam — the same minimal `node-postgres` shape the
 * other DB parts use. admin.crud uses it for READS ONLY (list/get); it never
 * issues a write through it (writes go through part mutators). Wiring: seams.md §2.
 */
export interface SqlExecutor {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

// ── The data_ownership.reads contract surface (RFC 0004), as admin.crud reads it ──

/** One readable column. `redact:true` columns are never selected or returned. */
export interface ColumnDescriptor {
  name: string;
  /** Logical rendering hint: string|number|boolean|timestamp|uuid|json. Not the SQL type. */
  type: string;
  label?: string;
  redact?: boolean;
  /** Marks an opaque cross-part id (link, not join) — the auth.tenancy pattern. */
  references_capability?: string;
}

/** The read descriptor for one table (the value side of data_ownership.reads). */
export interface ReadDescriptor {
  label?: string;
  primary_key: string | string[];
  order_by?: string;
  columns: ColumnDescriptor[];
  /** Action → the part's public-export name that performs it. Absent ⇒ read-only. */
  mutations?: { create?: string; update?: string; delete?: string };
}

/** table → descriptor, i.e. one part's `data_ownership.reads`. */
export type ReadsMap = Record<string, ReadDescriptor>;

/** One installed part's declared read surface. */
export interface ResourceDeclaration {
  part: string;
  reads: ReadsMap;
}

/** A minimal parsed-contract shape for `collectReads` — structural, no core dep. */
export interface ContractLike {
  part: string;
  data_ownership?: { reads?: ReadsMap } | undefined;
}

// ── Writes: dispatched to app-wired part mutators; admin.crud never writes SQL ──

/** Arguments admin.crud hands a mutator. The app's wired function takes what it needs. */
export interface MutatorArgs {
  /** Primary-key values (update/delete). */
  key?: KeyInput;
  /** New-row input (create). */
  input?: Record<string, unknown>;
  /** Changed fields (update). */
  patch?: Record<string, unknown>;
}

/** A write the app wires from a part's public export. Its own typed errors propagate. */
export type Mutator = (args: MutatorArgs) => Promise<unknown> | unknown;

/** part → exportName → mutator. `mutations` in the contract names the export. */
export type MutatorRegistry = Record<string, Record<string, Mutator>>;

/** Primary-key value(s): column → value. */
export type KeyInput = Record<string, string | number>;

/** List paging. Search/filter is a roadmap item. */
export interface ListOptions {
  limit?: number;
  offset?: number;
}

/** A row of declared, non-redacted columns. */
export type AdminRow = Record<string, unknown>;

/** What `admin()` binds: the declared resources, an optional db (reads), and mutators (writes). */
export interface AdminConfig {
  resources: ResourceDeclaration[];
  db?: SqlExecutor;
  mutators?: MutatorRegistry;
}

/** UI metadata for one administered resource (redacted columns excluded). */
export interface ResourceInfo {
  part: string;
  table: string;
  label: string;
  primaryKey: string[];
  columns: { name: string; type: string; label?: string; referencesCapability?: string }[];
  /** Which write actions are available (a mutation is declared for them). */
  actions: { create: boolean; update: boolean; delete: boolean };
}

/** The admin surface, bound to one config by `admin(config)`. */
export interface Admin {
  /** The administered resources across all installed parts that declare reads. */
  resources(): ResourceInfo[];
  /** Read rows of `table`, projecting only declared non-redacted columns. */
  list(table: string, opts?: ListOptions): Promise<AdminRow[]>;
  /** Read one row by primary key, or null. */
  get(table: string, key: KeyInput): Promise<AdminRow | null>;
  /** Create via the part's `mutations.create` export (never raw SQL). */
  create(table: string, input: Record<string, unknown>): Promise<unknown>;
  /** Update via the part's `mutations.update` export (never raw SQL). */
  update(table: string, key: KeyInput, patch: Record<string, unknown>): Promise<unknown>;
  /** Delete via the part's `mutations.delete` export (never raw SQL). */
  remove(table: string, key: KeyInput): Promise<unknown>;
}
