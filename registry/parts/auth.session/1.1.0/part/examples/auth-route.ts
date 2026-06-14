/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app as
 * app/api/auth/[...all]/route.ts and edit freely. Not attested.
 *
 * After copying, change the import to your alias (seams.md §1):
 *   import { authHandler } from "@parts/auth.session";
 *
 * This catch-all route is how the Better Auth client (browser) signs in/out
 * and reads sessions. Cookies are managed for you.
 */
import { authHandler } from "../src/index";

// MUST run in the Node.js runtime: the part talks to Postgres via `pg`, which
// is not available on the Edge runtime (seams.md §3).
export const runtime = "nodejs";

export const GET = authHandler;
export const POST = authHandler;
