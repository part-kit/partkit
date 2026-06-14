/**
 * Conformance suite for capability flags.feature@1.
 *
 * Each test names the contract invariant it makes true — the invariant list in
 * contract.json and this file stay 1:1.
 *
 * Two blocks:
 *  - DB-free (always on): invariant 1 (fail-safe eval + fail-fast management),
 *    5 (type-safety validation), 6 (own-table), and the deterministic bucketing
 *    math of invariant 2 — exercised with a recording executor.
 *  - Real Postgres (gated on PARTKIT_TEST_DATABASE_URL): sticky/uniform rollout,
 *    rule matching, disabled-vs-archived-vs-unknown, stored-wrong-type fail-safe,
 *    and injection — against the part's actual shipped migration.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags, FlagError, type SqlExecutor } from "../src/index";
import { bucket, pickVariant } from "../src/internal/eval";
import { cannedFlagRow, RecordingExecutor } from "./recording-executor";

const TABLE_RE = /\b(from|into|update|join|table)\s+"?([a-z_][a-z0-9_.]*)"?/gi;
function assertOwnTableOnly(calls: { sql: string }[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const { sql } of calls) {
    for (const m of sql.matchAll(TABLE_RE)) {
      const name = m[2]!.toLowerCase();
      if (name === "set") continue; // "ON CONFLICT … DO UPDATE SET" — a keyword, not a table
      expect(name).toBe("feature_flags");
    }
  }
}

// ── DB-free ──────────────────────────────────────────────────────────────────
describe("conformance: flags.feature@1 · DB-free (no database required)", () => {
  it("invariant 1: evaluate is FAIL-SAFE — a storage failure returns the fallback, never throws", async () => {
    const rec = new RecordingExecutor();
    rec.failWith = new Error("FATAL: connection refused");
    const ff = flags(rec);
    await expect(ff.evaluate("any", { subjectId: "u1" }, "FALLBACK")).resolves.toBe("FALLBACK");
    await expect(ff.evaluate("any", {}, true)).resolves.toBe(true);
    await expect(ff.evaluateAll({ subjectId: "u1" })).resolves.toEqual({}); // storage error → empty
  });

  it("invariant 1/4: an unknown flag returns the caller's fallback", async () => {
    const rec = new RecordingExecutor();
    rec.rows = []; // no row for the key
    await expect(flags(rec).evaluate("missing", { subjectId: "u" }, 42)).resolves.toBe(42);
  });

  it("invariant 1: management operations validate fast with a typed FlagError and issue zero SQL", async () => {
    const rec = new RecordingExecutor();
    const ff = flags(rec);
    await expect(ff.setFlag({ key: "", type: "boolean", enabled: true, default: false })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(ff.setFlag({ key: "k", type: "nope" as never, enabled: true, default: false })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(ff.archiveFlag("")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(ff.getFlag("")).rejects.toMatchObject({ code: "invalid_input" });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 5: setFlag rejects a default/variant/rule value whose type ≠ the declared type (zero SQL)", async () => {
    const rec = new RecordingExecutor();
    const ff = flags(rec);
    // default mismatch
    await expect(ff.setFlag({ key: "k", type: "boolean", enabled: true, default: "not-a-bool" })).rejects.toMatchObject({ code: "invalid_input" });
    // rollout variant mismatch
    await expect(
      ff.setFlag({ key: "k", type: "number", enabled: true, default: 0, rollout: [{ value: "x", weight: 1 }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // NaN is not a valid number
    await expect(ff.setFlag({ key: "k", type: "number", enabled: true, default: Number.NaN })).rejects.toMatchObject({ code: "invalid_input" });
    // a json flag rejects non-serializable values (NaN, BigInt) rather than
    // throwing a raw TypeError / silently coercing to null at write time
    await expect(ff.setFlag({ key: "k", type: "json", enabled: true, default: Number.NaN as never })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(ff.setFlag({ key: "k", type: "json", enabled: true, default: 10n as unknown as never })).rejects.toMatchObject({ code: "invalid_input" });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 3: a targeting rule on an inherited property name (__proto__) never matches", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [
      cannedFlagRow({
        type: "string",
        default: "base",
        rules: [{ conditions: [{ attribute: "__proto__", op: "neq", value: "x" }], variant: "matched" }],
      }),
    ];
    // an attribute-less context must NOT match the __proto__ neq rule → flag default
    await expect(flags(rec).evaluate("k", {}, "fb")).resolves.toBe("base");
    await expect(flags(rec).evaluate("k", { attributes: {} }, "fb")).resolves.toBe("base");
  });

  it("invariant 5: evaluate honors the caller's fallback type — a flag retyped away from T returns the fallback", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [cannedFlagRow({ type: "string", default: "hello" })];
    // the flag resolves to a string, but the caller's fallback is a boolean → the
    // string must not escape as a boolean; return the boolean fallback instead.
    await expect(flags(rec).evaluate("k", { subjectId: "u" }, false)).resolves.toBe(false);
  });

  it("invariant 5: a stored value of the wrong type fails safe to the fallback", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [cannedFlagRow({ type: "number", default: "oops-a-string", enabled: true })];
    // resolved value "oops-a-string" ≠ number → fallback
    await expect(flags(rec).evaluate("k", { subjectId: "u" }, 7)).resolves.toBe(7);
  });

  it("invariant 6: every statement the part issues targets only feature_flags", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [cannedFlagRow()];
    const ff = flags(rec);
    await ff.setFlag({ key: "k", type: "boolean", enabled: true, default: false }); // UPSERT
    await ff.evaluate("k", { subjectId: "u" }, false); // SELECT_ACTIVE
    await ff.getFlag("k"); // SELECT_ONE
    await ff.listFlags(); // SELECT_ALL_ACTIVE
    await ff.archiveFlag("k"); // ARCHIVE
    assertOwnTableOnly(rec.calls);
  });

  it("invariant 2: bucketing is deterministic, in-range, sticky, uniform, and key-salted", () => {
    // pinned vector — a refactor that changes the hash is caught
    expect(bucket("new-checkout", "user-42")).toBeCloseTo(0.47585, 5);
    // deterministic + sticky
    expect(bucket("k", "u")).toBe(bucket("k", "u"));
    // injective join: a ':' in either field must NOT collide (length-prefixed)
    expect(bucket("f", "org:1")).not.toBe(bucket("f:org", "1"));
    expect(bucket("feature", "x:y")).not.toBe(bucket("feature:x", "y"));
    // range
    for (let i = 0; i < 1000; i += 1) {
      const b = bucket("flagX", `subject-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(1);
    }
    // uniformity: a 10% cutoff catches ~10% of 100k subjects
    let underA = 0;
    let underBoth = 0;
    const N = 100_000;
    for (let i = 0; i < N; i += 1) {
      const s = `subject-${i}`;
      const a = bucket("flag-A", s) < 0.1;
      const b = bucket("flag-B", s) < 0.1;
      if (a) underA += 1;
      if (a && b) underBoth += 1;
    }
    expect(underA / N).toBeGreaterThan(0.095);
    expect(underA / N).toBeLessThan(0.105);
    // salt independence: P(in 10% of B | in 10% of A) ≈ 0.1, NOT ≈ 1.0
    expect(underBoth / underA).toBeGreaterThan(0.07);
    expect(underBoth / underA).toBeLessThan(0.13);
  });

  it("invariant 2: pickVariant splits by cumulative relative weight", () => {
    const variants = [{ value: "control", weight: 1 }, { value: "treat", weight: 3 }];
    expect(pickVariant(variants, 0)).toBe("control");
    expect(pickVariant(variants, 0.2)).toBe("control"); // < 0.25
    expect(pickVariant(variants, 0.5)).toBe("treat"); // >= 0.25
    expect(pickVariant([], 0.5)).toBeUndefined();
    expect(pickVariant([{ value: "x", weight: 0 }], 0.5)).toBeUndefined(); // all-zero weight
  });
});

// ── Real Postgres ────────────────────────────────────────────────────────────
const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];

interface RecordingPg extends SqlExecutor {
  statements: string[];
}

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "conformance: flags.feature@1 · real Postgres",
  () => {
    const schema = `flags_conf_${process.pid}`;
    let client: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };
    let db: RecordingPg;
    let seq = 0;
    const k = (): string => `flag_${process.pid}_${(seq += 1)}`;

    beforeAll(async () => {
      const pg = (await import("pg")).default;
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      client = c as unknown as typeof client;
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema}`);
      const migration = await readFile(new URL("../migrations/001-create-feature-flags.sql", import.meta.url), "utf8");
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

    it("invariant 2: percentage rollout is sticky per subject and ~uniform across subjects", async () => {
      const key = k();
      const ff = flags(db);
      await ff.setFlag({
        key,
        type: "boolean",
        enabled: true,
        default: false,
        rollout: [{ value: true, weight: 20 }, { value: false, weight: 80 }],
      });
      // sticky: same subject → same value twice
      const first = await ff.evaluate(key, { subjectId: "stable-user" }, false);
      const again = await ff.evaluate(key, { subjectId: "stable-user" }, false);
      expect(again).toBe(first);
      // ~uniform: ~20% of 2000 subjects get `true`
      let on = 0;
      for (let i = 0; i < 2000; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if ((await ff.evaluate(key, { subjectId: `u-${i}` }, false)) === true) on += 1;
      }
      expect(on / 2000).toBeGreaterThan(0.15);
      expect(on / 2000).toBeLessThan(0.25);
    });

    it("invariant 3: rules are first-match-wins with conditions AND-ed; non-match falls through to default", async () => {
      const key = k();
      const ff = flags(db);
      await ff.setFlag({
        key,
        type: "string",
        enabled: true,
        default: "standard",
        rules: [
          { conditions: [{ attribute: "plan", op: "eq", value: "enterprise" }, { attribute: "region", op: "eq", value: "us" }], variant: "premium" },
          { conditions: [{ attribute: "plan", op: "eq", value: "enterprise" }], variant: "business" },
        ],
      });
      // both conditions of rule 1 → premium
      expect(await ff.evaluate(key, { attributes: { plan: "enterprise", region: "us" } }, "x")).toBe("premium");
      // only plan matches → rule 1 fails (AND), rule 2 matches → business
      expect(await ff.evaluate(key, { attributes: { plan: "enterprise", region: "eu" } }, "x")).toBe("business");
      // no rule matches → default
      expect(await ff.evaluate(key, { attributes: { plan: "free" } }, "x")).toBe("standard");
      // a missing attribute never matches (incl. would-be neq traps): no attributes → default
      expect(await ff.evaluate(key, {}, "x")).toBe("standard");
    });

    it("invariant 4: disabled → flag default; archived/unknown → caller fallback", async () => {
      const ff = flags(db);
      const disabled = k();
      await ff.setFlag({ key: disabled, type: "boolean", enabled: false, default: true });
      // disabled returns the flag's OWN default, not the caller's fallback
      expect(await ff.evaluate(disabled, { subjectId: "u" }, false)).toBe(true);

      const archived = k();
      await ff.setFlag({ key: archived, type: "boolean", enabled: true, default: true });
      await ff.archiveFlag(archived);
      expect(await ff.evaluate(archived, { subjectId: "u" }, false)).toBe(false); // → caller fallback
      // getFlag still sees the archived flag (management visibility); listFlags excludes it
      expect((await ff.getFlag(archived))?.archivedAt).toBeInstanceOf(Date);
      expect((await ff.listFlags()).map((f) => f.key)).not.toContain(archived);
      // re-setting un-archives
      await ff.setFlag({ key: archived, type: "boolean", enabled: true, default: true });
      expect((await ff.getFlag(archived))?.archivedAt).toBeNull();
      expect(await ff.evaluate(archived, { subjectId: "u" }, false)).toBe(true);

      // unknown flag → caller fallback
      expect(await ff.evaluate("never-defined", { subjectId: "u" }, "FB")).toBe("FB");
    });

    it("invariant 5: a stored value of the wrong type fails safe to the fallback", async () => {
      const key = k();
      // bypass setFlag's validation to inject a corrupt row, then evaluate must fail safe
      await client.query(
        `INSERT INTO feature_flags (key, type, enabled, "default") VALUES ($1, 'number', true, '"a-string-not-a-number"'::jsonb)`,
        [key],
      );
      expect(await flags(db).evaluate(key, { subjectId: "u" }, 99)).toBe(99);
    });

    it("invariant 6: SQL metacharacters in key/attributes round-trip as data; the table survives", async () => {
      const evil = "k'); DROP TABLE feature_flags; --";
      const ff = flags(db);
      await ff.setFlag({
        key: evil,
        type: "string",
        enabled: true,
        default: "base",
        rules: [{ conditions: [{ attribute: evil, op: "eq", value: evil }], variant: "matched" }],
      });
      expect(await ff.evaluate(evil, { attributes: { [evil]: evil } }, "x")).toBe("matched");
      expect((await ff.getFlag(evil))?.key).toBe(evil);
      const exists = await client.query("SELECT to_regclass('feature_flags') AS t");
      expect(exists.rows[0]!["t"]).not.toBeNull();
      assertOwnTableOnly(db.statements.map((sql) => ({ sql })));
    });
  },
);
