/**
 * Conformance suite for capability auth.session@1.
 *
 * Two blocks, the audit.log pattern:
 *  - DB-free (always on): config validation + typed errors, exercised before
 *    any database is touched — so the suite attests a non-zero result even
 *    where no Postgres is available (CI without a PG service).
 *  - Real Postgres + real Better Auth (gated on PARTKIT_TEST_DATABASE_URL): the
 *    actual flows — sign-up, sign-in, sessions, sign-out, password hashing —
 *    run against the library and a database, never a mock (docs/02 §4). The
 *    part's own shipped migration creates the tables.
 *
 * The DB-free block must run FIRST: getAuth() memoizes on first success, so the
 * "missing secret" assertion has to execute before the real-PG block builds it.
 *
 * Each test names the contract invariant it makes true — contract.json and this
 * file stay 1:1.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuthError,
  getSession,
  requireSession,
  signIn,
  signOut,
  signUp,
} from "../src/index";

const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];
const SECRET = "partkit-conformance-secret-0123456789abcdef";

// ── DB-free: config validation + typed errors ────────────────────────────────
describe("conformance: auth.session@1 · DB-free", () => {
  it("invariant 1: missing config is a typed error at call time, not import time", async () => {
    // Import already happened with no env and did not throw or connect.
    const saved = { ...process.env };
    delete process.env["BETTER_AUTH_SECRET"];
    delete process.env["AUTH_DATABASE_URL"];
    delete process.env["BETTER_AUTH_URL"];
    try {
      await expect(getSession(new Headers())).rejects.toMatchObject({
        name: "AuthError",
        code: "config",
      });
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it("invariant 7: a config error never leaks the secret value", async () => {
    const saved = { ...process.env };
    process.env["BETTER_AUTH_SECRET"] = SECRET;
    delete process.env["AUTH_DATABASE_URL"]; // force a different missing-var error
    try {
      const err = await getSession(new Headers()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).not.toContain(SECRET);
    } finally {
      for (const k of ["AUTH_DATABASE_URL"]) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

// ── Real Postgres + real Better Auth ─────────────────────────────────────────
describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "conformance: auth.session@1 · real Better Auth + Postgres",
  () => {
    let admin: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> };
    const TABLES = ["auth_session", "auth_account", "auth_verification", "auth_user"];
    let n = 0;
    const email = (): string => `u${(n += 1)}.${process.pid}@conformance.test`;

    beforeAll(async () => {
      const pg = (await import("pg")).default;
      const client = new pg.Client({ connectionString: PG_URL });
      await client.connect();
      admin = {
        query: async (sql, params) => {
          const r = await client.query(sql, params === undefined ? undefined : [...params]);
          return { rows: r.rows as Record<string, unknown>[] };
        },
        end: () => client.end(),
      };
      // Fresh tables in the public schema (the part connects to the same DB).
      await admin.query(`DROP TABLE IF EXISTS ${TABLES.join(", ")} CASCADE`);
      const migration = await readFile(
        new URL("../migrations/001-create-auth-tables.sql", import.meta.url),
        "utf8",
      );
      await admin.query(migration);

      process.env["BETTER_AUTH_SECRET"] = SECRET;
      process.env["AUTH_DATABASE_URL"] = PG_URL as string;
      process.env["BETTER_AUTH_URL"] = "http://localhost:3000";
    });

    afterAll(async () => {
      if (admin !== undefined) {
        await admin.query(`DROP TABLE IF EXISTS ${TABLES.join(", ")} CASCADE`);
        await admin.end();
      }
    });

    const cookieOf = (setCookie: string): Headers =>
      new Headers({ cookie: setCookie.split(";", 1)[0] ?? "" });

    it("invariant 2: signUp persists a user + session, hashes the password, rejects duplicates", async () => {
      const e = email();
      const res = await signUp({ email: e, password: "correct horse battery", name: "Alice" });
      expect(res.user.email).toBe(e);
      expect(res.user.id.length).toBeGreaterThan(0);
      expect(res.session.userId).toBe(res.user.id);
      expect(res.setCookie).toContain("better-auth");

      // the stored password is a hash, never the plaintext
      const acct = await admin.query(
        'SELECT "password" FROM auth_account WHERE "userId" = $1',
        [res.user.id],
      );
      const stored = acct.rows[0]?.["password"];
      expect(typeof stored).toBe("string");
      expect(stored).not.toBe("correct horse battery");
      expect((stored as string).length).toBeGreaterThan(40);

      // duplicate email → typed error
      await expect(
        signUp({ email: e, password: "another password here", name: "Alice2" }),
      ).rejects.toMatchObject({ name: "AuthError", code: "email_taken" });
    });

    it("invariant 3: signIn issues a session getSession resolves; bad creds → invalid_credentials, no enumeration", async () => {
      const e = email();
      await signUp({ email: e, password: "the right password", name: "Bob" });

      const res = await signIn({ email: e, password: "the right password" });
      const session = await getSession(cookieOf(res.setCookie));
      expect(session?.user.email).toBe(e);

      // wrong password and unknown email: same code, same message
      const wrong = await signIn({ email: e, password: "the wrong password" }).catch((x: unknown) => x);
      const unknown = await signIn({ email: "nobody@conformance.test", password: "whatever 123" }).catch((x: unknown) => x);
      expect((wrong as AuthError).code).toBe("invalid_credentials");
      expect((unknown as AuthError).code).toBe("invalid_credentials");
      expect((wrong as AuthError).message).toBe((unknown as AuthError).message);
    });

    it("invariant 4: getSession resolves valid / null otherwise; requireSession throws when absent", async () => {
      const e = email();
      const res = await signUp({ email: e, password: "valid password yes", name: "Carol" });

      expect(await getSession(cookieOf(res.setCookie))).not.toBeNull();
      expect(await getSession(new Headers())).toBeNull();
      expect(await getSession(new Headers({ cookie: "better-auth.session_token=garbage.signature" }))).toBeNull();

      await expect(requireSession(new Headers())).rejects.toMatchObject({
        name: "AuthError",
        code: "unauthenticated",
      });
      await expect(requireSession(cookieOf(res.setCookie))).resolves.toMatchObject({
        user: { email: e },
      });
    });

    it("invariant 5: signOut invalidates the session", async () => {
      const e = email();
      const res = await signUp({ email: e, password: "soon to be gone", name: "Dave" });
      const cookie = cookieOf(res.setCookie);
      expect(await getSession(cookie)).not.toBeNull();

      await signOut(cookie);
      expect(await getSession(cookie)).toBeNull();
    });

    it("invariant 6: authHandler is a mountable fetch handler serving the auth routes", async () => {
      const { authHandler } = await import("../src/index");
      const req = new Request("http://localhost:3000/api/auth/get-session", { method: "GET" });
      const res = await authHandler(req);
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBeLessThan(500); // 200 with null body when unauthenticated
    });
  },
);
