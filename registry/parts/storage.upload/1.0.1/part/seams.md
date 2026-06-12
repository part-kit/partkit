# Seams — storage.upload

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested
interior; edits void the attestation and fail CI).

## 1. Environment

The part holds your storage credentials and reads them lazily at call time.
`partkit add` scaffolds these into `.env.example`:

| Var | Required | Notes |
|---|---|---|
| `STORAGE_ENDPOINT` | yes | Base URL of the S3 API, e.g. `https://s3.us-east-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, `https://minio.example.com:9000`. |
| `STORAGE_REGION` | yes | e.g. `us-east-1`. R2 uses `auto`. |
| `STORAGE_BUCKET` | yes | The bucket name. |
| `STORAGE_ACCESS_KEY_ID` | yes | Public key id (appears in the URL — not secret). |
| `STORAGE_SECRET_ACCESS_KEY` | yes | **Secret.** Stays on the server; never sent to the browser. |
| `STORAGE_FORCE_PATH_STYLE` | no | `true` (default) → `endpoint/bucket/key`; `false` → `bucket.endpoint/key`. MinIO needs `true`; AWS S3 works either way; R2 typically `false`. |

```ts
import { presignUpload, presignDownload, StorageError } from "@parts/storage.upload";
```

Never deep-import `src/internal/**` (lint-enforced).

## 2. The flow — presign on the server, transfer in the browser

The part **only signs URLs** — it never moves bytes and never calls the
network. The upload happens directly between the browser and your storage:

1. Browser asks your API for a presigned URL (`examples/upload-route.ts`).
2. Server calls `presignUpload(key)` and returns `{ url, method, headers }`.
3. Browser does `fetch(url, { method, headers, body: file })`
   (`examples/browser-upload.ts`).
4. Browser tells your API the `key`; you store it against the record.

```ts
const { url, method, headers, expiresAt } = await presignUpload("uploads/u1/photo.jpg", {
  expiresInSeconds: 300, // 1..604800, default 900
});
// later, to serve a private object:
const dl = await presignDownload("uploads/u1/photo.jpg");
```

`headers` is `{}` in v1 (only `host` is signed, which the browser sets itself)
— spread it anyway so future signed headers keep working.

## 3. Choosing the object key (YOUR responsibility)

You pick the key; the part signs it. Rules:

- **Derive keys server-side** from a trusted id — never let the client choose
  the full path, or one user can presign over another's objects. Namespace by
  user/tenant: `uploads/<userId>/<random>-<name>`.
- Keys may contain `/`, spaces, and Unicode (they are encoded for you).
  Rejected: empty, a leading `/`, control characters, and keys over 1024 bytes
  (a `StorageError` with code `invalid_key`).

## 4. CORS — the one provider-side setup

Because the browser uploads cross-origin to your storage host, the **bucket
must allow your site's origin** for `PUT` (and `GET` for downloads), exposing
no special headers. Set this once in your provider's CORS config — it is not
something the part can do for you. Symptom when missing: the `fetch` PUT fails
with a CORS error in the browser console while `presignUpload` itself succeeds.

## 5. Error handling

Every failure is a `StorageError` with `.code`:

- `config` — a missing/invalid `STORAGE_*` env var (your deploy is
  misconfigured → treat as 500).
- `invalid_key` — see §3 (client's fault → 400).
- `invalid_options` — `expiresInSeconds` outside `1..604800`.

The secret key is scrubbed from every error message.

## 6. What you must NOT do

- Edit or import anything under `src/internal/**`.
- Send `STORAGE_SECRET_ACCESS_KEY` to the browser, or presign in client code.
- Let the client supply the raw object key (§3).
- Set very long expiries for sensitive objects — a presigned URL is a bearer
  token for that one object until it expires; prefer minutes, not days.
