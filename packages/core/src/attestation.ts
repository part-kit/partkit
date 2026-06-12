import { z } from "zod";
import { PART_NAME_RE, SEMVER_RE } from "./contract.js";

export const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * ATTESTATION.json — signed verification record, re-issued continuously (docs/02 §5).
 * `content_hash` binds the attestation to the exact vendored content (the
 * vendored tree minus ATTESTATION.json itself, to avoid circularity) — this is
 * what makes signature verification the control against malice (docs/03 §8).
 *
 * Signature schemes: `dev:` (unsigned, local development only — verify warns),
 * `sigstore:` (planned; verify fails closed until implemented).
 */
export const AttestationSchema = z.object({
  part: z.string().regex(PART_NAME_RE),
  version: z.string().regex(SEMVER_RE),
  adapter: z.string().nullable(),
  content_hash: z.string().regex(CONTENT_HASH_RE),
  verified_at: z.string().datetime(),
  dependency_matrix: z.record(z.string()).default({}),
  conformance_run: z.string(),
  tests_passed: z.number().int().nonnegative(),
  result_hash: z.string(),
  signature: z.string(),
  expires: z.string().datetime(),
});
export type Attestation = z.infer<typeof AttestationSchema>;
