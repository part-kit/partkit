/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * Not attested. Shows server-side session reads — the common way to gate a
 * route, a Server Component, or a server action.
 *
 * After copying, change the import to your alias (seams.md §1):
 *   import { getSession, requireSession, AuthError } from "@parts/auth.session";
 */
import { AuthError, getSession, requireSession } from "../src/index";

/** A protected route handler: 401 unless there's a valid session. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireSession(request.headers);
    return Response.json({ id: user.id, email: user.email });
  } catch (e) {
    if (e instanceof AuthError) return new Response(null, { status: e.status });
    throw e;
  }
}

/** Optional read for UI: returns the user or null without throwing. */
export async function currentUser(headers: Headers): Promise<{ id: string; email: string } | null> {
  const session = await getSession(headers);
  return session === null ? null : { id: session.user.id, email: session.user.email };
}
