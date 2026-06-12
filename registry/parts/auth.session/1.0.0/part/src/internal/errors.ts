export type AuthErrorCode =
  | "config"
  | "unauthenticated"
  | "invalid_credentials"
  | "email_taken"
  | "invalid_input"
  | "auth";

/** Recommended HTTP status per code, for callers that answer a request. */
const STATUS: Record<AuthErrorCode, number> = {
  config: 500,
  unauthenticated: 401,
  invalid_credentials: 401,
  email_taken: 409,
  invalid_input: 400,
  auth: 500,
};

/**
 * The only error type that escapes the part. Better Auth's internal `APIError`
 * values are translated into these typed, stable codes (contract invariant 7),
 * so the app never depends on Better Auth's error shapes and no internal detail
 * or secret leaks through.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = STATUS[code];
  }
}
