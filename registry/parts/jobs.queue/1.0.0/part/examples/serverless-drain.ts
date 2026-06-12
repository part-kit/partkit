/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * The SERVERLESS shape (seams.md §6): one drain pass per invocation, triggered
 * by your platform's cron (e.g. Vercel Cron / Cloud Scheduler hitting a route).
 * In serverless, the platform cron is also your jobs.cron trigger (docs/05 §1).
 *
 * Mount this from a route handler, e.g. Next.js `app/api/jobs/drain/route.ts`:
 *   import { drainHandler } from "@/jobs/serverless-drain";
 *   export const POST = drainHandler;
 *   export const runtime = "nodejs";   // graphile-worker uses pg, not Edge
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { drainOnce } from "@parts/jobs.queue";
 */
import { drainOnce } from "../src/index";
import { tasks } from "./tasks";

/**
 * Process all currently-due jobs, then return. Guard the route — draining is not
 * public; require a shared secret your platform cron sends.
 */
export async function drainHandler(request: Request): Promise<Response> {
  const secret = process.env["JOBS_DRAIN_SECRET"];
  if (secret !== undefined && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("forbidden", { status: 403 });
  }

  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined) {
    return new Response("DATABASE_URL is not configured", { status: 500 });
  }

  await drainOnce({ connectionString, tasks });
  return Response.json({ ok: true });
}
