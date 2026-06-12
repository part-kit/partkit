/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app's client code and
 * edit freely. Not attested. Shows the browser half of the flow: ask your own
 * API for a presigned URL, then PUT the file straight to storage.
 *
 * This file imports nothing from the part — presigning is server-side. It is
 * here to document the contract your `examples/upload-route.ts` exposes.
 */

interface PresignResponse {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  key: string;
}

export async function uploadFile(file: File, userId: string): Promise<string> {
  // 1. Ask YOUR server to presign (it holds the credentials, the browser never does).
  const res = await fetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: file.name, userId }),
  });
  const { url, method, headers, key } = (await res.json()) as PresignResponse;

  // 2. Upload the bytes directly to storage with the presigned URL.
  const put = await fetch(url, { method, headers: { ...headers }, body: file });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);

  // 3. Persist `key` against the user/record — that's what you fetch later.
  return key;
}
