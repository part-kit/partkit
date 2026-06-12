export type AdminErrorCode =
  | "unknown_resource"
  | "read_only"
  | "no_mutator"
  | "invalid_input"
  | "invalid_contract"
  | "storage";

/**
 * The only error type admin.crud itself throws. `unknown_resource` (table not in
 * any declared reads), `read_only` (no mutation for the action), `no_mutator`
 * (mutation declared but the app wired no function), `invalid_input` (bad key /
 * options / missing db), `invalid_contract` (a malformed reads declaration —
 * e.g. a non-identifier column name), and `storage` (a read through the seam
 * failed) carry a GENERIC message; the raw driver error is attached as `cause`,
 * never put in `message`. A mutator's OWN errors are NOT wrapped — they
 * propagate unchanged so the part's invariants stay where they are enforced
 * (contract invariant 4).
 */
export class AdminError extends Error {
  readonly code: AdminErrorCode;

  constructor(code: AdminErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "AdminError";
    this.code = code;
  }
}
