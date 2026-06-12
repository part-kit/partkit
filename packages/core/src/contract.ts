import semver from "semver";
import { z } from "zod";

/** Two-level, lowercase capability/part names: `billing.subscription` (docs/02 §3). */
export const PART_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
export const SEMVER_RE = /^\d+\.\d+\.\d+$/;
/** `provides` pins the implemented capability major: `billing.subscription@1`. */
export const PROVIDES_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*@\d+$/;
/** `requires` references capability majors, never concrete parts: `auth.session>=1`. */
export const REQUIRES_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*>=\d+$/;

export const AdapterStatusSchema = z.enum(["attested", "community", "experimental"]);
export type AdapterStatus = z.infer<typeof AdapterStatusSchema>;

/**
 * Wrapped-OSS runtime packages (RFC 0001): `name → semver range`. Ranges in
 * the contract, exact pins in the attestation (`npm:` keys). Types-only,
 * transitive, and test-only packages do not belong here.
 */
export const NpmDependenciesSchema = z.record(
  z.string().refine((r) => semver.validRange(r) !== null, "not a valid semver range"),
);
export type NpmDependencies = z.infer<typeof NpmDependenciesSchema>;

/**
 * contract.json — the machine-readable promise (docs/02 §2).
 * Design rules enforced here: no `slo` field (not conformance-testable yet),
 * `platform` is not a capability, http_routes are mounts the app re-exports,
 * `npm_dependencies` requires contract_version 0.2 so pre-RFC-0001 parsers
 * fail closed instead of silently skipping installs.
 */
export const ContractSchema = z.object({
  part: z.string().regex(PART_NAME_RE),
  version: z.string().regex(SEMVER_RE),
  contract_version: z.enum(["0.1", "0.2"]),
  provides: z.array(z.string().regex(PROVIDES_RE)).min(1),
  requires: z.array(z.string().regex(REQUIRES_RE)).default([]),
  platform: z.record(z.string()).default({}),
  npm_dependencies: NpmDependenciesSchema.optional(),
  adapters: z
    .array(
      z.object({
        name: z.string().min(1),
        vendor_api: z.string(),
        status: AdapterStatusSchema,
        npm_dependencies: NpmDependenciesSchema.optional(),
      }),
    )
    .default([]),
  interface: z.object({
    exports: z.array(z.string()).min(1),
    events: z.array(z.string()).default([]),
    http_routes: z
      .array(z.object({ route: z.string(), export: z.string() }))
      .default([]),
  }),
  env: z
    .record(
      z.object({
        required: z.boolean(),
        secret: z.boolean().optional(),
        enum: z.array(z.string()).optional(),
      }),
    )
    .default({}),
  data_ownership: z
    .object({
      tables: z.array(z.string()),
      writes_only_own_tables: z.boolean(),
      // RFC 0004 — declared read surface for schema-driven admin tooling. Optional;
      // admin tools may SELECT only these tables/columns and write only via the
      // named public-export mutators. A column with redact:true is never read.
      reads: z
        .record(
          z.object({
            label: z.string().optional(),
            primary_key: z.union([z.string(), z.array(z.string()).min(1)]),
            order_by: z.string().optional(),
            columns: z
              .array(
                z.object({
                  name: z.string(),
                  type: z.string(),
                  label: z.string().optional(),
                  redact: z.boolean().optional(),
                  references_capability: z.string().optional(),
                }),
              )
              .min(1),
            mutations: z
              .object({
                create: z.string().optional(),
                update: z.string().optional(),
                delete: z.string().optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  invariants: z.array(z.string()).default([]),
  threat_model: z.string().optional(),
  license: z.string(),
  attestation: z.string().optional(),
})
  .superRefine((c, ctx) => {
    const hasDeps =
      c.npm_dependencies !== undefined ||
      c.adapters.some((a) => a.npm_dependencies !== undefined);
    if (hasDeps && c.contract_version === "0.1") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contract_version"],
        message: "npm_dependencies requires contract_version 0.2 (RFC 0001)",
      });
    }
  });
export type Contract = z.infer<typeof ContractSchema>;

/** `billing.subscription@1` → `billing.subscription`. */
export function capabilityOf(provides: string): string {
  const at = provides.indexOf("@");
  return at === -1 ? provides : provides.slice(0, at);
}

/** Part-wide ∪ selected adapter's npm dependencies (RFC 0001 §2a). */
export function effectiveNpmDependencies(
  contract: Contract,
  adapter: string | null,
): NpmDependencies {
  const adapterDeps =
    adapter !== null
      ? (contract.adapters.find((a) => a.name === adapter)?.npm_dependencies ?? {})
      : {};
  return { ...(contract.npm_dependencies ?? {}), ...adapterDeps };
}
