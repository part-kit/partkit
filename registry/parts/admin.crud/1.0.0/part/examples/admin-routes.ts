/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * The two composition seams (seams.md §6): gate the admin with auth.session, and
 * record every admin write to audit.log — by wrapping the part mutators.
 *
 * After copying, change imports to your alias and import the REAL parts:
 *   import { admin, AdminError } from "@parts/admin.crud";
 *   import { requireSession } from "@parts/auth.session";   // gate the routes
 *   import { tenancy }        from "@parts/auth.tenancy";   // a part you administer
 *   import { auditLog }       from "@parts/audit.log";      // the trail
 */
import {
  admin,
  AdminError,
  type Admin,
  type MutatorRegistry,
  type ResourceDeclaration,
  type SqlExecutor,
} from "../src/index";

/** The staff principal you resolve from auth.session before any admin call. */
interface Staff {
  id: string;
}

/**
 * Build a request-scoped admin. `db` serves reads; `partMutators` are your real
 * part exports (e.g. `(args) => tenancy(db).deleteOrganization(String(args.key!.id))`).
 * Each is wrapped so a successful write is recorded to the audit trail — the
 * audit.log composition. admin.crud itself still issues no write SQL.
 */
export function buildAdmin(opts: {
  resources: ResourceDeclaration[];
  db: SqlExecutor;
  staff: Staff;
  partMutators: MutatorRegistry;
  audit: (action: string, target: string) => Promise<void>;
}): Admin {
  const mutators: MutatorRegistry = {};
  for (const [part, exports] of Object.entries(opts.partMutators)) {
    const wrapped: Record<string, (typeof exports)[string]> = {};
    for (const [name, fn] of Object.entries(exports)) {
      wrapped[name] = async (args) => {
        const result = await fn(args);
        const target = JSON.stringify(args.key ?? args.input ?? {});
        await opts.audit(`admin.${name}`, target);
        return result;
      };
    }
    mutators[part] = wrapped;
  }
  return admin({ resources: opts.resources, db: opts.db, mutators });
}

/**
 * A list route, gated by staff auth. Resolve `staff` from
 * `requireSession(headers)` (auth.session) BEFORE calling — admin.crud trusts
 * that you authorized.
 */
export async function listResource(
  buildFor: (staff: Staff) => Admin,
  staff: Staff,
  table: string,
): Promise<Response> {
  try {
    const rows = await buildFor(staff).list(table, { limit: 100 });
    return Response.json({ rows });
  } catch (e) {
    return new Response(JSON.stringify({ error: messageFor(e) }), { status: statusForAdminError(e) });
  }
}

/** Map an AdminError to an HTTP status for your route handler. */
export function statusForAdminError(e: unknown): number {
  if (e instanceof AdminError) {
    if (e.code === "unknown_resource") return 404;
    if (e.code === "read_only" || e.code === "no_mutator") return 405;
    if (e.code === "invalid_input" || e.code === "invalid_contract") return 400;
  }
  return 500;
}

function messageFor(e: unknown): string {
  return e instanceof AdminError ? e.message : "internal error";
}
