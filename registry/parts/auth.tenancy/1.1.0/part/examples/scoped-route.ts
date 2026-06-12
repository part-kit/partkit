/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 *
 * The two composition seams that make tenancy real (seams.md §3, §4):
 *
 *  - with auth.session: the principal (`userId`) is NOT owned here — it comes
 *    from auth.session's `requireSession(headers)` / `getSession(headers)` at
 *    the app's seam, and is passed in. This part references it, never stores it.
 *
 *  - row-level scoping: `requireMembership` turns that principal into a
 *    verified, role-checked scope; you then filter YOUR OWN tables by the
 *    organization id FROM THAT SCOPE. The gate and the filter are the two halves
 *    of tenant isolation — never run the second without the first.
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { tenancy, TenancyError } from "@parts/auth.tenancy";
 */
import { tenancy, TenancyError, type SqlExecutor } from "../src/index";

/** The slice of node-postgres your app-table query needs. */
interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * List the app's own `projects` rows for ONE organization — but only for an
 * admin (or owner) of it.
 *
 * @param db     the tenancy SqlExecutor (examples/pg-executor.ts)
 * @param appDb  your application's pool, for your own tables
 * @param organizationId  from the request (e.g. the URL: /orgs/:id/projects)
 * @param userId  the auth.session principal: (await requireSession(headers)).user.id
 */
export async function listProjectsForOrg(
  db: SqlExecutor,
  appDb: PgQueryable,
  organizationId: string,
  userId: string,
): Promise<Record<string, unknown>[]> {
  // 1. GATE — throws TenancyError("forbidden") if `userId` is not at least an
  //    admin of `organizationId`. A client-supplied org id is never trusted
  //    until it has passed through here.
  const scope = await tenancy(db).requireMembership({ organizationId, userId, role: "admin" });

  // 2. SCOPE — filter the app's own table by the VERIFIED org id from the scope.
  const result = await appDb.query(
    "SELECT id, name FROM projects WHERE org_id = $1 ORDER BY created_at DESC",
    [scope.organizationId],
  );
  return result.rows;
}

/** Map a TenancyError to an HTTP status for your route handler. */
export function statusForTenancyError(e: unknown): number {
  if (e instanceof TenancyError) {
    if (e.code === "forbidden") return 403;
    if (e.code === "not_found" || e.code === "not_a_member") return 404;
    if (e.code === "invalid_input") return 400;
  }
  return 500;
}
