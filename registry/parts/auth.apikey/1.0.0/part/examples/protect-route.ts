/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * The hot path: authenticate a programmatic request by its API key, requiring
 * scopes, and turn a typed ApiKeyError into the right HTTP status.
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { apiKeys, ApiKeyError, type SqlExecutor } from "@parts/auth.apikey";
 */
import { apiKeys, ApiKeyError, type ApiKeyContext, type SqlExecutor } from "../src/index";

/**
 * Wrap any API handler so it runs only for a valid key carrying every required
 * scope. Mount this in your route, e.g. a Next.js Route Handler:
 *   export const POST = (req: Request) =>
 *     withApiKey(db, ["models.write"], (req, ctx) => generate(req, ctx))(req);
 */
export function withApiKey(
  db: SqlExecutor,
  scopes: string[],
  handler: (request: Request, ctx: ApiKeyContext) => Promise<Response>,
): (request: Request) => Promise<Response> {
  const guard = apiKeys(db).requireApiKey(scopes);
  return async (request: Request): Promise<Response> => {
    let ctx: ApiKeyContext;
    try {
      ctx = await guard(request);
    } catch (e) {
      if (e instanceof ApiKeyError) return errorResponse(e);
      throw e; // a real storage failure — let your error boundary 500 it
    }
    return handler(request, ctx);
  };
}

/** Map each typed code to a status. `forbidden` is 403; everything else is 401. */
function errorResponse(e: ApiKeyError): Response {
  const status = e.code === "forbidden" ? 403 : 401;
  // Surface only the stable code — never the message (defensive) or any detail
  // that would tell a guesser whether a key existed.
  return new Response(JSON.stringify({ error: e.code }), {
    status,
    headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
  });
}
