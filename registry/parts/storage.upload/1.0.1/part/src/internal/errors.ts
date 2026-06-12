export type StorageErrorCode = "config" | "invalid_key" | "invalid_options";

/**
 * The only error type that escapes the part. Presigning never touches the
 * network, so there is no "storage"/transport error — every failure is a
 * programming/configuration mistake caught at call time. The secret access
 * key is scrubbed from every message before it is constructed (invariant 7).
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}
