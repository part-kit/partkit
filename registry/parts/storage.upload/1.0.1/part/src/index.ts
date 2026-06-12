/**
 * storage.upload — public interface. The ONLY legal import surface.
 * Contract: ../contract.json · What your app must provide: ../seams.md
 */
import { buildPresigned } from "./internal/presign";
import type {
  PresignDownloadOptions,
  PresignedRequest,
  PresignUploadOptions,
} from "./internal/types";

export { StorageError } from "./internal/errors";
export type { StorageErrorCode } from "./internal/errors";
export type {
  PresignDownloadOptions,
  PresignedRequest,
  PresignUploadOptions,
} from "./internal/types";

/**
 * Presign a direct-to-storage upload (HTTP PUT). Hand the returned URL to a
 * browser or client; the bytes go straight to your S3-compatible provider,
 * never through your app.
 *
 * Importing this module performs no I/O and never throws; the SigV4 signature
 * is pure computation (no network), and configuration is validated here, at
 * call time, with typed errors (contract invariants 1, 7).
 */
// `async` so that validation/config errors thrown by buildPresigned surface as
// a rejected promise, not a synchronous throw, regardless of call site.
export async function presignUpload(
  key: string,
  opts?: PresignUploadOptions,
): Promise<PresignedRequest> {
  return buildPresigned("PUT", key, opts?.expiresInSeconds);
}

/**
 * Presign a direct-from-storage download (HTTP GET) — a time-limited URL for a
 * private object, without making it public.
 */
export async function presignDownload(
  key: string,
  opts?: PresignDownloadOptions,
): Promise<PresignedRequest> {
  return buildPresigned("GET", key, opts?.expiresInSeconds);
}
