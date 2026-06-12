/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app (e.g.
 * app/api/uploads/route.ts) and edit freely. Not attested.
 *
 * After copying, change the import to your alias (seams.md §1):
 *   import { presignUpload } from "@parts/storage.upload";
 *
 * The server mints a short-lived presigned PUT URL; the browser uploads the
 * bytes straight to your storage. The file never passes through your app.
 */
import { presignUpload, StorageError } from "../src/index.js";

interface UploadRequestBody {
  filename: string;
  userId: string;
}

export async function POST(request: Request): Promise<Response> {
  const { filename, userId } = (await request.json()) as UploadRequestBody;

  // YOUR domain: derive a safe, namespaced key. Never trust the client's path.
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  const key = `uploads/${userId}/${Date.now()}-${safe}`;

  try {
    const { url, method, headers, expiresAt } = await presignUpload(key, {
      expiresInSeconds: 300, // 5 minutes is plenty for an interactive upload
    });
    return Response.json({ url, method, headers, key, expiresAt });
  } catch (e) {
    if (e instanceof StorageError) {
      // config errors are a 500 (our misconfig); a bad key is the client's 400.
      const status = e.code === "config" ? 500 : 400;
      return Response.json({ error: e.code }, { status });
    }
    throw e;
  }
}
