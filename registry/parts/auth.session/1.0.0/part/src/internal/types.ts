/** A stable, Better-Auth-independent view of the authenticated user. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A stable view of the active session. */
export interface AuthSession {
  id: string;
  userId: string;
  /** Opaque session token (the value inside the session cookie). */
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

/** What getSession/requireSession resolve to. */
export interface SessionResult {
  user: AuthUser;
  session: AuthSession;
}

/**
 * What signUp/signIn return: the session plus the `Set-Cookie` header value to
 * attach to your HTTP response so the browser is logged in. (The browser flow
 * through authHandler sets this cookie automatically; this is for server-side
 * sign-in, e.g. a server action.)
 */
export interface AuthResult extends SessionResult {
  setCookie: string;
}

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
}

export interface SignInInput {
  email: string;
  password: string;
}
