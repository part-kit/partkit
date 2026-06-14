/**
 * Conformance suite for capability search.fulltext@1.
 *
 * Each test names the contract invariant it makes true — the invariant list in
 * contract.json and this file stay 1:1.
 *
 * Two blocks:
 *  - DB-free (always on): invariant 1 (typed errors), 6's own-table + params
 *    halves — with a recording executor.
 *  - Real Postgres (gated on PARTKIT_TEST_DATABASE_URL): upsert/remove, ranked
 *    search (title over body), raw-query safety, type filter, pagination,
 *    empty/multi-match, and injection — against the part's actual migration.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { search, SearchError, type SqlExecutor } from "../src/index";
import { cannedResultRow, RecordingExecutor } from "./recording-executor";

const TABLE_RE = /\b(from|into|update|join|table)\s+"?([a-z_][a-z0-9_.]*)"?/gi;
function assertOwnTableOnly(calls: { sql: string }[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const { sql } of calls) {
    for (const m of sql.matchAll(TABLE_RE)) {
      const name = m[2]!.toLowerCase();
      if (name === "set") continue; // "ON CONFLICT … DO UPDATE SET" — a keyword, not a table
      expect(name).toBe("search_documents");
    }
  }
}

// ── DB-free ──────────────────────────────────────────────────────────────────
describe("conformance: search.fulltext@1 · DB-free (no database required)", () => {
  it("invariant 1: a storage failure surfaces as a typed SearchError, raw error redacted", async () => {
    const rec = new RecordingExecutor();
    rec.failWith = new Error("FATAL: password authentication failed for user 'secret'");
    const err = await search(rec)
      .query({ q: "hello" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchError);
    expect((err as SearchError).code).toBe("storage");
    expect((err as SearchError).message).not.toContain("password authentication failed");
  });

  it("invariant 1: invalid input fails fast with a typed SearchError and issues zero SQL", async () => {
    const rec = new RecordingExecutor();
    const idx = search(rec);
    await expect(idx.index({ ref: "", body: "x" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.index({ ref: "r", body: "" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.remove("")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.query({ q: "x", limit: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.query({ q: "x", limit: 101 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.query({ q: "x", offset: -1 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 3/5: an empty query short-circuits to an empty array with zero SQL", async () => {
    const rec = new RecordingExecutor();
    await expect(search(rec).query({ q: "" })).resolves.toEqual([]);
    await expect(search(rec).query({ q: "   " })).resolves.toEqual([]);
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 6: every statement targets only search_documents; the raw query is a bound param", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [cannedResultRow()];
    const idx = search(rec);
    const evil = "foo & bar:'); DROP TABLE search_documents; --";
    await idx.index({ ref: "r", title: "t'); DROP", body: "b" }); // UPSERT
    await idx.query({ q: evil, type: "listing", limit: 10 }); // SEARCH (raw q bound)
    await idx.remove("r"); // DELETE
    assertOwnTableOnly(rec.calls);
    for (const c of rec.calls) expect(c.sql).not.toContain("DROP TABLE");
    expect(rec.calls.some((c) => c.params.includes(evil))).toBe(true);
  });

  it("invariant 1/3: a NUL byte in any input is rejected as invalid_input before SQL (never a storage 500)", async () => {
    const rec = new RecordingExecutor();
    const idx = search(rec);
    const NUL = "\u0000";
    // query path: a NUL would otherwise reach Postgres (SQLSTATE 22021) and 500 — must
    // fail fast as invalid_input, keeping invariant 3 ("never throws on raw input") true.
    await expect(idx.query({ q: `lea${NUL}ther` })).rejects.toMatchObject({ code: "invalid_input" });
    // index path: a NUL in ref/title/body or anywhere in metadata is invalid_input, not a 500.
    await expect(idx.index({ ref: `r${NUL}`, body: "b" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.index({ ref: "r", body: `b${NUL}` })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.index({ ref: "r", title: `t${NUL}`, body: "b" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.index({ ref: "r", body: "b", metadata: { k: `v${NUL}` } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.index({ ref: "r", body: "b", metadata: { [`k${NUL}`]: "v" } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.remove(`r${NUL}`)).rejects.toMatchObject({ code: "invalid_input" });
    expect(rec.calls).toHaveLength(0); // every rejection happened before any SQL
  });

  it("invariant 4/5: a deep offset that would force a full rank-sort is rejected (bounded at 10_000)", async () => {
    const rec = new RecordingExecutor();
    const idx = search(rec);
    await expect(idx.query({ q: "x", offset: 10_001 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(idx.query({ q: "x", offset: 100_000 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(rec.calls).toHaveLength(0);
  });

  it("invariant 4 (DoS): ts_headline runs over a length-capped slice, not the full (<=1MB) body", async () => {
    const rec = new RecordingExecutor();
    rec.rows = [cannedResultRow()];
    await search(rec).query({ q: "chair", limit: 100 });
    const searchSql = rec.calls.map((c) => c.sql).find((sql) => sql.includes("ts_headline"));
    expect(searchSql).toBeDefined();
    // headline input is left(coalesce(...), 8192) — per-row cost is O(const), not O(body size)
    expect(searchSql).toMatch(/left\(\s*coalesce/);
    expect(searchSql).toContain("8192");
  });
});

// ── Real Postgres ────────────────────────────────────────────────────────────
const PG_URL = process.env["PARTKIT_TEST_DATABASE_URL"];

interface RecordingPg extends SqlExecutor {
  statements: string[];
}

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "conformance: search.fulltext@1 · real Postgres",
  () => {
    const schema = `search_conf_${process.pid}`;
    let client: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };
    let db: RecordingPg;
    let seq = 0;
    const ref = (): string => `r_${process.pid}_${(seq += 1)}`;
    const tok = (): string => `t${process.pid}x${(seq += 1)}`;

    beforeAll(async () => {
      const pg = (await import("pg")).default;
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      client = c as unknown as typeof client;
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema}`);
      const migration = await readFile(new URL("../migrations/001-create-search-documents.sql", import.meta.url), "utf8");
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

    it("invariant 2: index upserts by ref — re-indexing replaces, never duplicates; remove is idempotent", async () => {
      const idx = search(db);
      const r = ref();
      const t = tok();
      const first = `${t}alpha`;
      const second = `${t}beta`;
      await idx.index({ ref: r, type: t, title: "doc", body: `${first} common` });
      await idx.index({ ref: r, type: t, title: "doc", body: `${second} common` }); // same ref
      const count = await client.query(`SELECT count(*)::int AS n FROM search_documents WHERE ref = $1`, [r]);
      expect(count.rows[0]!["n"]).toBe(1); // replaced, not duplicated
      expect((await idx.query({ q: second, type: t })).map((x) => x.ref)).toEqual([r]); // new content searchable
      expect(await idx.query({ q: first, type: t })).toEqual([]); // old content gone
      await idx.remove(r);
      expect((await client.query(`SELECT count(*)::int AS n FROM search_documents WHERE ref = $1`, [r])).rows[0]!["n"]).toBe(0);
      await expect(idx.remove(r)).resolves.toBeUndefined(); // idempotent
      await expect(idx.remove("never-existed")).resolves.toBeUndefined();
    });

    it("invariant 4: results are ranked by ts_rank with title outranking body, plus a snippet", async () => {
      const idx = search(db);
      const t = tok();
      const term = `${t}zorp`; // a rare invented term — nothing else matches, no stemming
      const titleDoc = ref();
      const bodyDoc = ref();
      await idx.index({ ref: titleDoc, type: t, title: term, body: "common filler text" });
      await idx.index({ ref: bodyDoc, type: t, title: "plain heading", body: `${term} common filler text` });
      const results = await idx.query({ q: term, type: t });
      expect(results).toHaveLength(2);
      expect(results[0]!.ref).toBe(titleDoc); // title (weight A) outranks body (weight B)
      expect(results[0]!.rank).toBeGreaterThan(results[1]!.rank);
      expect(results[1]!.ref).toBe(bodyDoc);
      expect(results[0]!.snippet.length).toBeGreaterThan(0); // highlighted excerpt
    });

    it("invariant 4: query filters by type", async () => {
      const idx = search(db);
      const term = `${tok()}filt`;
      const ta = `${tok()}A`;
      const tb = `${tok()}B`;
      const ra = ref();
      await idx.index({ ref: ra, type: ta, title: "x", body: `${term} listing` });
      await idx.index({ ref: ref(), type: tb, title: "y", body: `${term} post` });
      expect((await idx.query({ q: term, type: ta })).map((x) => x.ref)).toEqual([ra]); // only type A
      expect((await idx.query({ q: term })).length).toBe(2); // no filter → both
    });

    it("invariant 4/5: pagination is deterministic and non-overlapping", async () => {
      const idx = search(db);
      const t = tok();
      const term = `${t}page`;
      const refs: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const r = ref();
        refs.push(r);
        // identical body → equal rank → ordered by the stable ref tiebreak
        // eslint-disable-next-line no-await-in-loop
        await idx.index({ ref: r, type: t, title: "p", body: `${term} same body` });
      }
      const page1 = await idx.query({ q: term, type: t, limit: 2, offset: 0 });
      const page2 = await idx.query({ q: term, type: t, limit: 2, offset: 2 });
      const page3 = await idx.query({ q: term, type: t, limit: 2, offset: 4 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page3).toHaveLength(1);
      const seen = [...page1, ...page2, ...page3].map((x) => x.ref);
      expect(new Set(seen).size).toBe(5); // no row appears on two pages
      expect([...seen].sort()).toEqual([...refs].sort());
    });

    it("invariant 3: a raw user query never throws on FTS syntax", async () => {
      const idx = search(db);
      const t = tok();
      await idx.index({ ref: ref(), type: t, title: "Office", body: `${t}word leather chair desk` });
      for (const q of ["foo:", '"a b"', "x & y", "-neg", 'unbalanced " quote', "a or b", "!!!", "café", "(foo", ":*"]) {
        // eslint-disable-next-line no-await-in-loop
        await expect(idx.query({ q, type: t })).resolves.toBeInstanceOf(Array); // websearch_to_tsquery never raises
      }
    });

    it("invariant 5: no match → empty array; multiple matches come back best-first", async () => {
      const idx = search(db);
      const t = tok();
      const term = `${t}freq`;
      expect(await idx.query({ q: `${t}nomatchatall`, type: t })).toEqual([]);
      const three = ref();
      const two = ref();
      const one = ref();
      await idx.index({ ref: one, type: t, title: "h", body: `${term} extra` });
      await idx.index({ ref: two, type: t, title: "h", body: `${term} ${term} extra` });
      await idx.index({ ref: three, type: t, title: "h", body: `${term} ${term} ${term} extra` });
      const results = await idx.query({ q: term, type: t });
      expect(results).toHaveLength(3);
      expect(results[0]!.ref).toBe(three); // most occurrences ranks highest
      for (let i = 0; i + 1 < results.length; i += 1) {
        expect(results[i]!.rank).toBeGreaterThanOrEqual(results[i + 1]!.rank);
      }
    });

    it("invariant 6: SQL metacharacters round-trip as data; the table survives (injection)", async () => {
      const idx = search(db);
      const t = tok();
      const evil = "'); DROP TABLE search_documents; --";
      const r = ref();
      await idx.index({ ref: r, type: t, title: evil, body: `${t}searchable ${evil}`, metadata: { note: evil } });
      await expect(idx.query({ q: evil, type: t })).resolves.toBeInstanceOf(Array); // no throw, no DROP
      const hit = await idx.query({ q: `${t}searchable`, type: t });
      expect(hit).toHaveLength(1);
      expect(hit[0]!.ref).toBe(r);
      expect(hit[0]!.metadata["note"]).toBe(evil); // round-tripped as data
      const exists = await client.query("SELECT to_regclass('search_documents') AS t");
      expect(exists.rows[0]!["t"]).not.toBeNull();
      await idx.remove(r);
      assertOwnTableOnly(db.statements.map((sql) => ({ sql })));
    });

    it("invariant 4 (DoS): a match in a body far larger than the headline cap still highlights, bounded", async () => {
      const idx = search(db);
      const t = tok();
      const term = `${t}beacon`;
      // body ~140KB — far past the 8192-char ts_headline cap; the match sits near the front
      const body = `${term} ` + "filler ".repeat(20_000);
      const r = ref();
      await idx.index({ ref: r, type: t, title: "big", body });
      const results = await idx.query({ q: term, type: t });
      expect(results).toHaveLength(1);
      expect(results[0]!.ref).toBe(r);
      expect(results[0]!.snippet).toContain("<mark>"); // highlighted despite the huge body
      expect(results[0]!.snippet.length).toBeLessThan(2_000); // a bounded excerpt, never the whole body
    });
  },
);
