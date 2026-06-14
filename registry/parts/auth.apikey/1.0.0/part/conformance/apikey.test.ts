/**
 * Conformance suite for capability auth.apikey@1.
 *
 * Each test names the contract invariant it makes true — the invariant list in
 * contract.json and this file must stay 1:1. This part has no registry adapters
 * (the database connection is an app seam), so the publish script runs the
 * suite once.
 *
 * Two blocks:
 *  - DB-free (always on): invariants 1, 7, and the no-DB facets of 3/5/8 —
 *    typed errors, fail-fast validation, the malformed/header paths, and the
 *    own-table-only assertion, exercised with a recording executor. Plus a
 *    known-answer vector anchoring the HMAC hash construction (invariant 2/3).
 *  - Real Postgres (gated on PARTKIT_TEST_DATABASE_URL): invariants 2-6 and 8's
 *    persistence side — issue/verify/scope/rotate/revoke against a real database
 *    running the part's own shipped migration (docs/02 §4).
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiKeys, ApiKeyError, type SqlExecutor } from "../src/index";
import { hashSecret } from "../src/internal/keys";
import { cannedKeyRow, RecordingExecutor } from "./recording-executor";

const TABLE_RE = /\b(from|into|update|join|table)\s+"?([a-z_][a-z0-9_.]*)"?/gi;
function assertOwnTableOnly(statements: { sql: string }[]): void {
  expect(statements.length).toBeGreaterThan(0);
  for (const { sql } of statements) {
    for (const m of sql.matchAll(TABLE_RE)) {
      expect(m[2]).toBe("auth_apikey_keys");
    }
  }
}

// ── DB-free: typed errors, fail-fast validation, own-table SQL, hash vector ──
describe("conformance: auth.apikey@1 · DB-free (no database required)", () => {
  it("invariant 1: a storage failure surfaces as a typed ApiKeyError, raw error redacted", async () => {
    const rec = new RecordingExecutor();
    rec.failWith = new Error("FATAL: password authentication failed for user 'secret'");
    const keys = apiKeys(rec);
    const err = await keys.issueKey({ ownerId: "u1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiKeyError);
    expect((err as ApiKeyError).code).toBe("storage");
    expect((err as ApiKeyError).message).not.toContain("password authentication failed");
    // The raw driver error is preserved on cause for debugging, not in message.
    expect((err as ApiKeyError).cause).toBeInstanceOf(Error);
  });

  it("invariant 1: invalid input fails fast with a typed error and issues zero SQL", async () => {
    const rec = new RecordingExecutor();
    const keys = apiKeys(rec);
    await expect(keys.issueKey({ ownerId: "" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      keys.issueKey({ ownerId: "u", scopes: ["ok", ""] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      keys.issueKey({ ownerId: "u", expiresAt: new Date("not-a-date") }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      keys.rotateKey("akX", { graceSeconds: -1 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 3: a malformed key is rejected as `malformed` with zero SQL", async () => {
    const rec = new RecordingExecutor();
    const keys = apiKeys(rec);
    const tooLong = `akAAAAAAAAAAAA_${"a".repeat(500)}`; // oversized secret → bounded out, no megabyte HMAC
    for (const bad of ["", "garbage", "no-underscore", "ak_short", "xx_" + "a".repeat(20), tooLong]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(keys.verifyKey(bad)).rejects.toMatchObject({ name: "ApiKeyError", code: "malformed" });
    }
    // A non-string is malformed too (callers pass untrusted input).
    await expect(keys.verifyKey(undefined as unknown as string)).rejects.toMatchObject({
      code: "malformed",
    });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 5: requireApiKey rejects a missing or garbled Authorization header as `malformed`", async () => {
    const rec = new RecordingExecutor();
    const guard = apiKeys(rec).requireApiKey(["models.read"]);
    const noHeader = new Request("https://api.example/x");
    const wrongScheme = new Request("https://api.example/x", { headers: { authorization: "Basic abc" } });
    // An oversized header is rejected up front (pre-auth DoS amplifier) — never
    // trimmed/regex'd/sliced in full, and never reaches the database.
    const huge = new Request("https://api.example/x", {
      headers: { authorization: `Bearer ${"A".repeat(9000)}` },
    });
    await expect(guard(noHeader)).rejects.toMatchObject({ code: "malformed" });
    await expect(guard(wrongScheme)).rejects.toMatchObject({ code: "malformed" });
    await expect(guard(huge)).rejects.toMatchObject({ code: "malformed" });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 7: no secret material appears in error messages", async () => {
    const rec = new RecordingExecutor();
    const keys = apiKeys(rec);
    // verify-invalid must not echo the presented secret back.
    rec.rows = []; // unknown prefix → invalid
    const presented = "akAAAAAAAAAAAA_supersecretvalue1234567890";
    const err = await keys.verifyKey(presented).catch((e: unknown) => e);
    expect((err as ApiKeyError).code).toBe("invalid");
    expect((err as ApiKeyError).message).not.toContain("supersecretvalue");
  });

  it("invariant 8: every statement the part issues targets only auth_apikey_keys", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [cannedKeyRow()];
    const keys = apiKeys(rec);
    await keys.issueKey({ ownerId: "owner_1", name: "n", scopes: ["a"] }); // INSERT
    await keys.verifyKey("akAAAAAAAAAAAA_" + "z".repeat(20)).catch(() => undefined); // SELECT then invalid
    await keys.listKeys("owner_1"); // SELECT by owner
    await keys.revokeKey("akCanned000000"); // UPDATE revoke
    await keys.rotateKey("akCanned000000"); // SELECT + INSERT + UPDATE
    assertOwnTableOnly(rec.calls);
  });

  it("invariant 2/3: hashSecret is HMAC-SHA256(salt, secret) — known-answer vector", () => {
    // Anchors the stored hash to a fixed, one-way, salted construction so a
    // weaker or reversible hash cannot silently pass the fake-free DB-free path.
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const digest = hashSecret("the-secret", salt).toString("hex");
    expect(digest).toBe("52afcee434e4ed110dc1829f74d44ae0d4e3334a0480f5226c5a9a83e43721dd");
  });
});

// ── Real Postgres: issue, verify, scope, rotate, revoke, injection ───────────
const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];

interface RecordingPg extends SqlExecutor {
  statements: string[];
}

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "conformance: auth.apikey@1 · real Postgres",
  () => {
    const schema = `apikey_conf_${process.pid}`;
    let client: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };
    let db: RecordingPg;
    let seq = 0;
    const owner = (): string => `owner_${process.pid}_${(seq += 1)}`;

    beforeAll(async () => {
      const pg = (await import("pg")).default;
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      client = c as unknown as typeof client;
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema}`);
      // Run the part's ACTUAL shipped migration — conformance covers the SQL the
      // consumer will run, not a hand-rolled table.
      const migration = await readFile(
        new URL("../migrations/001-create-apikey-tables.sql", import.meta.url),
        "utf8",
      );
      await c.query(migration);

      const statements: string[] = [];
      db = {
        statements,
        query: async (sql, params) => {
          statements.push(sql);
          const r = await c.query(sql, params === undefined ? undefined : [...params]);
          return { rows: r.rows as Record<string, unknown>[] };
        },
      };
    });

    afterAll(async () => {
      if (client !== undefined) {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await client.end();
      }
    });

    beforeEach(() => {
      if (db !== undefined) db.statements.length = 0;
    });

    it("invariant 2: plaintext is returned once; storage holds only a hash; listKeys leaks nothing", async () => {
      const o = owner();
      const keys = apiKeys(db);
      const issued = await keys.issueKey({ ownerId: o, name: "CI", scopes: ["models.read"] });
      expect(issued.plaintext.startsWith(`${issued.prefix}_`)).toBe(true);
      expect(issued.id).toBe(issued.prefix);

      // The issued key actually verifies — proving the stored hash corresponds
      // to the plaintext without the plaintext ever being stored.
      const ctx = await keys.verifyKey(issued.plaintext);
      expect(ctx.ownerId).toBe(o);
      expect(ctx.scopes).toEqual(["models.read"]);

      // listKeys exposes no plaintext or hash material.
      const list = await keys.listKeys(o);
      expect(list).toHaveLength(1);
      const info = list[0]!;
      expect(Object.keys(info)).not.toContain("plaintext");
      expect(Object.keys(info)).not.toContain("key_hash");
      expect(Object.keys(info)).not.toContain("salt");
      expect(JSON.stringify(info)).not.toContain(issued.plaintext.split("_")[1]!);

      // Directly: no stored column holds the plaintext; key_hash is bytea.
      const raw = await client.query(`SELECT * FROM auth_apikey_keys WHERE prefix = $1`, [issued.prefix]);
      const row = raw.rows[0]!;
      for (const v of Object.values(row)) {
        if (typeof v === "string") expect(v).not.toBe(issued.plaintext);
      }
      expect(Buffer.isBuffer(row["key_hash"])).toBe(true);
    });

    it("invariant 3: verify resolves a valid key; unknown prefix and wrong secret are indistinguishable", async () => {
      const o = owner();
      const keys = apiKeys(db);
      const issued = await keys.issueKey({ ownerId: o });

      // First use: lastUsedAt is null; a later use reflects the throttled write.
      const first = await keys.verifyKey(issued.plaintext);
      expect(first.lastUsedAt).toBeNull();
      const second = await keys.verifyKey(issued.plaintext);
      expect(second.lastUsedAt).toBeInstanceOf(Date);

      // Wrong secret on a REAL prefix and a totally unknown prefix both → invalid.
      const secret = issued.plaintext.split("_")[1]!;
      const wrongSecret = `${issued.prefix}_${"x".repeat(secret.length)}`;
      const unknownPrefix = `akZZZZZZZZZZZZ_${secret}`;
      const e1 = await keys.verifyKey(wrongSecret).catch((e: unknown) => e);
      const e2 = await keys.verifyKey(unknownPrefix).catch((e: unknown) => e);
      expect((e1 as ApiKeyError).code).toBe("invalid");
      expect((e2 as ApiKeyError).code).toBe("invalid");

      // No length oracle: a short and a long wrong secret both → invalid.
      const eShort = await keys.verifyKey(`${issued.prefix}_${"y".repeat(20)}`).catch((e: unknown) => e);
      const eLong = await keys.verifyKey(`${issued.prefix}_${"z".repeat(60)}`).catch((e: unknown) => e);
      expect((eShort as ApiKeyError).code).toBe("invalid");
      expect((eLong as ApiKeyError).code).toBe("invalid");
    });

    it("invariant 4: revoked → revoked and expired → expired, but only to a caller holding the secret", async () => {
      const o = owner();
      const keys = apiKeys(db);

      // Revocation is immediate and only disclosed to the secret holder.
      const live = await keys.issueKey({ ownerId: o });
      await keys.revokeKey(live.id);
      const revokedErr = await keys.verifyKey(live.plaintext).catch((e: unknown) => e);
      expect((revokedErr as ApiKeyError).code).toBe("revoked");
      // Someone WITHOUT the secret who knows the (revoked) prefix learns only `invalid`.
      const guesser = await keys
        .verifyKey(`${live.prefix}_${"q".repeat(33)}`)
        .catch((e: unknown) => e);
      expect((guesser as ApiKeyError).code).toBe("invalid");
      // revoke is idempotent.
      await expect(keys.revokeKey(live.id)).resolves.toBeUndefined();
      // revoke of an unknown id is not_found.
      await expect(keys.revokeKey("akDoesNotExist")).rejects.toMatchObject({ code: "not_found" });

      // A key issued already-expired verifies as expired (with the right secret).
      const past = await keys.issueKey({ ownerId: o, expiresAt: new Date(Date.now() - 1000) });
      const expiredErr = await keys.verifyKey(past.plaintext).catch((e: unknown) => e);
      expect((expiredErr as ApiKeyError).code).toBe("expired");
    });

    it("invariant 5: requireScopes is all-of; requireApiKey enforces it over the Bearer header", async () => {
      const o = owner();
      const keys = apiKeys(db);
      const issued = await keys.issueKey({ ownerId: o, scopes: ["models.read", "models.write"] });

      // all-of present → ok
      const ok = await keys.verifyKey(issued.plaintext, { requireScopes: ["models.read"] });
      expect(ok.ownerId).toBe(o);
      // a missing scope → forbidden (not silently downgraded)
      await expect(
        keys.verifyKey(issued.plaintext, { requireScopes: ["models.read", "billing.admin"] }),
      ).rejects.toMatchObject({ code: "forbidden" });

      // requireApiKey over a real Request
      const req = new Request("https://api.example/v1", {
        headers: { authorization: `Bearer ${issued.plaintext}` },
      });
      const ctx = await keys.requireApiKey(["models.write"])(req);
      expect(ctx.ownerId).toBe(o);
      await expect(keys.requireApiKey(["billing.admin"])(req)).rejects.toMatchObject({
        code: "forbidden",
      });
    });

    it("invariant 6: rotateKey grace is bounded and recorded — 0 retires the old key, a window keeps it", async () => {
      const o = owner();
      const keys = apiKeys(db);

      // grace 0 → old key retired immediately, new key works.
      const k1 = await keys.issueKey({ ownerId: o, scopes: ["s1"] });
      const k2 = await keys.rotateKey(k1.id, { graceSeconds: 0 });
      const oldErr = await keys.verifyKey(k1.plaintext).catch((e: unknown) => e);
      expect((oldErr as ApiKeyError).code).toBe("expired");
      const newCtx = await keys.verifyKey(k2.plaintext);
      expect(newCtx.ownerId).toBe(o);
      expect(newCtx.scopes).toEqual(["s1"]); // attributes carry over

      // Re-rotating the now-rotated old key is refused — the grace window stays
      // bounded in aggregate and no orphan keys are minted from a dead one.
      await expect(keys.rotateKey(k1.id, { graceSeconds: 86_400 })).rejects.toMatchObject({
        code: "invalid_input",
      });

      // a non-zero grace window keeps the old key valid alongside the new one.
      const g1 = await keys.issueKey({ ownerId: o });
      const g2 = await keys.rotateKey(g1.id, { graceSeconds: 3600 });
      await expect(keys.verifyKey(g1.plaintext)).resolves.toMatchObject({ ownerId: o });
      await expect(keys.verifyKey(g2.plaintext)).resolves.toMatchObject({ ownerId: o });

      // rotate of an unknown id is not_found.
      await expect(keys.rotateKey("akDoesNotExist")).rejects.toMatchObject({ code: "not_found" });
    });

    it("invariant 8: SQL metacharacters round-trip literally; statements touch only auth_apikey_keys", async () => {
      const evil = "o'); DROP TABLE auth_apikey_keys; --";
      const keys = apiKeys(db);
      const issued = await keys.issueKey({ ownerId: evil, name: evil, scopes: [evil] });
      const ctx = await keys.verifyKey(issued.plaintext);
      expect(ctx.ownerId).toBe(evil);
      expect(ctx.scopes).toEqual([evil]);
      const list = await keys.listKeys(evil);
      expect(list[0]!.name).toBe(evil);
      // The table still exists — the injection string was data, not SQL.
      const exists = await client.query("SELECT to_regclass('auth_apikey_keys') AS t");
      expect(exists.rows[0]!["t"]).not.toBeNull();
      // Every statement issued in THIS test targeted only the part's table.
      assertOwnTableOnly(db.statements.map((sql) => ({ sql })));
    });
  },
);
