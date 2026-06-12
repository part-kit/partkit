export {
  AdapterStatusSchema,
  PART_NAME_RE,
  ContractSchema,
  NpmDependenciesSchema,
  PROVIDES_RE,
  REQUIRES_RE,
  SEMVER_RE,
  capabilityOf,
  effectiveNpmDependencies,
  type AdapterStatus,
  type Contract,
  type NpmDependencies,
} from "./contract.js";
export { AttestationSchema, CONTENT_HASH_RE, type Attestation } from "./attestation.js";
export {
  LOCKFILE_NAME,
  LockfileEntrySchema,
  LockfileSchema,
  lockfilePath,
  readLockfile,
  writeLockfile,
  type Lockfile,
  type LockfileEntry,
} from "./lockfile.js";
export { ATTESTATION_FILE, hashPartDir } from "./hash.js";
export { SELECTED_ADAPTER_DIR, materializePart } from "./materialize.js";
export {
  DEFAULT_REGISTRY,
  HttpRegistry,
  ManifestSchema,
  RegistryIndexSchema,
  StaticRegistry,
  openRegistry,
  type FetchedContent,
  type Manifest,
  type PartRegistry,
  type RegistryIndex,
} from "./registry.js";
export { vendorPart, type VendorResult } from "./vendor.js";
export {
  AGENTS_TEMPLATE,
  PARTS_END,
  PARTS_START,
  CI_WORKFLOW,
  GUARD_MESSAGE,
  HOOK_MARKER,
  PRE_COMMIT_HOOK,
} from "./templates.js";
export { initRepo, type InitOptions, type InitResult } from "./ops/init.js";
export { addPart, type AddOptions, type AddResult } from "./ops/add.js";
export {
  verifyRepo,
  type Finding,
  type FindingLevel,
  type VerifyResult,
} from "./ops/verify.js";
export { guardRepo, type GuardResult } from "./ops/guard.js";
export { upgradePart, type UpgradeOptions, type UpgradeResult } from "./ops/upgrade.js";
export { ejectPart, type EjectOptions, type EjectResult } from "./ops/eject.js";
export {
  NO_EDIT_RULE,
  resolvePlan,
  type PlanEntry,
  type ResolveInput,
  type ResolvePlan,
} from "./ops/resolve.js";
export {
  MIGRATIONS_TABLE,
  NO_TRANSACTION_DIRECTIVE,
  planMigrations,
  runMigrations,
  type LedgerRow,
  type MigratePlan,
  type MigrateResult,
  type MigrationFile,
  type SqlExecutor,
} from "./ops/migrate.js";
